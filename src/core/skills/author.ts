import type { InteractionGraph } from "../graph/types";
import type { Reasoner } from "../reasoner/types";
import { areaDigest, generalDigest } from "./digest";
import type { AreaSlice } from "./group";
import {
    type AreaIndex,
    buildAreaIndex,
    buildGeneralIndex,
    DESTRUCTIVE_HEADING,
    type GeneralIndex,
    SAFETY_HEADING,
    SELECTORS_HEADING,
    verifyAuthoredSkill,
} from "./verify";

/** Up to 3 model calls total (initial + 2 repairs) before a skill is abandoned. */
const MAX_REPAIR_ATTEMPTS = 2;

/** Output budget for one skill body — generous so the prose is never truncated. */
const MAX_OUTPUT_TOKENS = 8000;

const AREA_SAFETY_NOTE =
    "Read-only is enforced by the Sentinel harness; the destructive controls listed above are recorded but never actuated.";
const GENERAL_SAFETY_NOTE =
    "Read-only is enforced by the Sentinel harness. Reach pages by clicking the app's own menus and links, never by editing the URL.";

export class SkillAuthoringError extends Error {
    readonly slug: string;
    readonly attempts: number;
    readonly residualErrors: string[];

    constructor(slug: string, attempts: number, residualErrors: string[]) {
        super(
            `Skill authoring for ${slug} failed verification after ${attempts} attempt(s): ${residualErrors.join("; ")}`,
        );
        this.name = "SkillAuthoringError";
        this.slug = slug;
        this.attempts = attempts;
        this.residualErrors = residualErrors;
    }
}

const AREA_SYSTEM = `You are a precise technical writer authoring a navigation SKILL.md body for an autonomous QA agent that reads it at planning time to drive a real web app like a human user. You are given a structured DIGEST of an automatically-crawled interaction graph — the COMPLETE and ONLY source of truth.

RULES:
1. Use ONLY the facts in the digest. Never invent or guess a route, page, page title, or control name. If it is not in the digest, it does not exist.
2. Copy routes and control names VERBATIM from the digest — character for character, including casing, slashes, and ":id" templates. Do not paraphrase, normalize, or "clean up" any identifier.
3. The agent reaches a page by clicking the app's own menu, sidebar, tab, or link — NEVER by editing the URL bar. When the digest shows "goes to <route> (via <control>)", phrase navigation as clicking that named control.
4. NEVER use a control marked DESTRUCTIVE in the digest as a step in a flow, and never describe one as safe to click.

Write ONLY these "## " sections, in this order — do NOT write a "## Selectors", "## Destructive controls", or "## Safety" section; the system appends those automatically:
## Purpose — 1–3 sentences: what this area is for and when the agent should load this skill. No filler, no marketing.
## Pages — one "### <route>" subsection per page, using the exact route from the digest (e.g. "### /campaigns/:id"). Under each: a one-sentence purpose, then the page's key links / actions / inputs by their exact accessible names in double quotes, and where notable links lead ("via <control name>").
## Flows — short numbered procedures for the meaningful things a user can do here, derived from the digest's "goes to ... via" transitions. Reference controls by their exact accessible name in double quotes. Never include a destructive control.

Output ONLY the Markdown body. Do NOT output YAML frontmatter, a top-level "# " H1 heading, or a fenced code block — start directly with "## ". Style: concrete and dense, GitHub-flavored Markdown, written for an agent reader.`;

const GENERAL_SYSTEM = `You are a precise technical writer authoring the general navigation SKILL.md body for an autonomous QA agent that reads it before driving a real web app like a human user. You are given a structured DIGEST of an automatically-crawled interaction graph — the COMPLETE and ONLY source of truth.

RULES:
1. Use ONLY the facts in the digest. Never invent a route, area, page, control, or skill slug.
2. Copy routes, control names, and slugs VERBATIM — character for character.
3. The agent navigates by clicking the app's own menus, sidebar, tabs, or links — NEVER by editing the URL bar.

Output ONLY the Markdown body. Do NOT output YAML frontmatter, a top-level "# " H1 heading, a fenced code block, or a "## Safety" section (the system appends it). Start directly with "## " and follow the section list in the instructions. Style: concrete and dense, GitHub-flavored Markdown, written for an agent reader.`;

function buildAreaPrompt(slice: AreaSlice, graph: InteractionGraph): string {
    const label = slice.area ?? "top-level";
    return `Area: "${label}" of the "${graph.repoId}" web app (base ${graph.baseUrl}).
Routes in this area: ${slice.routes.join(", ")}
Entry route(s) (the natural way in): ${slice.entryRoutes.join(", ")}

Write the SKILL.md body for this area following every rule in the system prompt. Use ONLY the DATA below.

In the DATA, each "### <route>" is a page state; the quoted string after it is the page title; "(N controls)" is the control count; "[flags: ...]" lists page flags. "links:"/"actions:"/"inputs:" list the page's controls by kind (their exact accessible names). "goes to:" lists outgoing transitions as "<target route> (via "<control name>")". "destructive:" lists controls that must never be actuated or used as a flow step.

== DATA ==
${areaDigest(slice, graph)}
== END DATA ==`;
}

function buildGeneralPrompt(graph: InteractionGraph, slices: AreaSlice[], slugs: Map<string | null, string>): string {
    return `Write the SKILL.md body for the general "how this app works" navigation skill for the "${graph.repoId}" web app (base ${graph.baseUrl}). Load this skill before driving the app: orient the agent on what the product is, its main areas and what each is for, how global navigation works, and how to move between sections. Cross-reference each area by its skill slug in backticks.

Use these exact "## " headings, in order (omit "## Global navigation (present on most pages)" if no persistent nav is given, omit "## Gotchas" if no flagged pages are given): "## Overview", "## Base & auth", "## Areas", "## Flows", "## Global navigation (present on most pages)", "## Gotchas". Do NOT write a "## Safety" section — the system appends it. "## Base & auth" must state the Base URL and the mapped date exactly as given below. "## Areas" lists each area as "- **<area label>** — <n> page(s); see \`<slug>\`". Use ONLY the DATA below.

== DATA ==
${generalDigest(graph, slices, slugs)}
== END DATA ==`;
}

function repairBlock(errors: string[]): string {
    const numbered = errors.map((error, i) => `${i + 1}. ${error}`).join("\n");
    return `\n\nYour previous answer was REJECTED. Fix ALL of these problems and re-send the COMPLETE corrected Markdown body (not a diff):\n${numbered}\nEvery route you mention must be a real route from the DATA above, and a destructive control must never appear as a flow step.`;
}

/** Strip an accidental ```markdown fenced wrapper the model may add around the body. */
function stripCodeFence(text: string): string {
    const trimmed = text.trim();
    if (trimmed.startsWith("```")) {
        return trimmed
            .replace(/^```[a-zA-Z]*\n?/, "")
            .replace(/\n?```$/, "")
            .trim();
    }
    return trimmed;
}

/**
 * Generate, verify, and (if needed) repair a single skill body. The model returns plain
 * Markdown prose; verification runs over that prose (routes it mentions must be real, no
 * destructive control as a flow step, required sections present). A verification failure
 * re-prompts with the exact errors; a model/transport error is retried. Exhausting the
 * retries throws {@link SkillAuthoringError}, so no unverified skill reaches disk.
 */
async function authorWithRepair(
    reasoner: Reasoner,
    slug: string,
    system: string,
    basePrompt: string,
    index: AreaIndex | GeneralIndex,
    baseLabel: string,
): Promise<string> {
    let repair = "";
    for (let attempt = 0; attempt <= MAX_REPAIR_ATTEMPTS; attempt++) {
        let body: string;
        try {
            const text = await reasoner.generateText({
                prompt: basePrompt + repair,
                system,
                maxTokens: MAX_OUTPUT_TOKENS,
                telemetryLabel: attempt === 0 ? baseLabel : `${baseLabel}-repair`,
            });
            body = stripCodeFence(text);
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            if (attempt === MAX_REPAIR_ATTEMPTS) {
                throw new SkillAuthoringError(slug, attempt + 1, [`model call failed: ${reason}`]);
            }
            continue;
        }
        const errors = verifyAuthoredSkill(body, index);
        if (errors.length === 0) {
            return body;
        }
        if (attempt === MAX_REPAIR_ATTEMPTS) {
            throw new SkillAuthoringError(slug, attempt + 1, errors);
        }
        repair = repairBlock(errors);
    }
    // Unreachable: the loop either returns a verified body or throws above.
    throw new SkillAuthoringError(slug, MAX_REPAIR_ATTEMPTS + 1, ["unreachable"]);
}

/**
 * The machine-exact tail of an area skill, appended by code (not the LLM): the destructive
 * control list and the ranked selectors copied verbatim from the graph, plus a safety note.
 * These are the parts an LLM can't reliably reproduce, so they're generated deterministically.
 */
function renderAreaAppendix(slice: AreaSlice): string {
    const parts: string[] = [];
    if (slice.destructive.length > 0) {
        parts.push(DESTRUCTIVE_HEADING);
        for (const name of slice.destructive) {
            parts.push(`- ${name} — recorded; never actuated.`);
        }
        parts.push("");
    }

    const seen = new Set<string>();
    const selectorLines: string[] = [];
    for (const node of slice.nodes) {
        for (const control of node.controls) {
            if (control.kind !== "navigation" && control.kind !== "action") {
                continue;
            }
            const name = control.name.trim();
            if (!name || control.selectors.length === 0 || seen.has(name)) {
                continue;
            }
            seen.add(name);
            selectorLines.push(`- ${name}: ${control.selectors.map((s) => `\`${s}\``).join(" → ")}`);
        }
    }
    if (selectorLines.length > 0) {
        parts.push(SELECTORS_HEADING, ...selectorLines, "");
    }

    parts.push(SAFETY_HEADING, AREA_SAFETY_NOTE);
    return parts.join("\n");
}

/** Author a per-area skill: LLM-written, graph-verified prose + a code-appended machine tail. */
export async function authorAreaSkill(
    reasoner: Reasoner,
    slug: string,
    slice: AreaSlice,
    graph: InteractionGraph,
): Promise<string> {
    const body = await authorWithRepair(
        reasoner,
        slug,
        AREA_SYSTEM,
        buildAreaPrompt(slice, graph),
        buildAreaIndex(slice, graph),
        "skill-area",
    );
    return `${body.trimEnd()}\n\n${renderAreaAppendix(slice)}\n`;
}

/** Author the general "how this app works" skill: LLM-written prose + a code-appended safety note. */
export async function authorGeneralSkill(
    reasoner: Reasoner,
    slug: string,
    graph: InteractionGraph,
    slices: AreaSlice[],
    slugs: Map<string | null, string>,
): Promise<string> {
    const body = await authorWithRepair(
        reasoner,
        slug,
        GENERAL_SYSTEM,
        buildGeneralPrompt(graph, slices, slugs),
        buildGeneralIndex(graph, slugs),
        "skill-general",
    );
    return `${body.trimEnd()}\n\n${SAFETY_HEADING}\n${GENERAL_SAFETY_NOTE}\n`;
}
