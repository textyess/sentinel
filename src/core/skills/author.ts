import { z } from "zod";
import type { InteractionGraph } from "../graph/types";
import type { Reasoner } from "../reasoner/types";
import { areaDigest, generalDigest } from "./digest";
import type { AreaSlice } from "./group";
import type { AuthoredSkill } from "./types";
import { type AreaIndex, buildAreaIndex, buildGeneralIndex, type GeneralIndex, verifyAuthoredSkill } from "./verify";

/** Up to 3 generateObject calls total (initial + 2 repairs) before a skill is abandoned. */
const MAX_REPAIR_ATTEMPTS = 2;

/** The model authors the prose body AND declares the concrete references, so verification is exact. */
const authoredSkillSchema = z.object({
    body: z.string().min(1),
    references: z.object({
        routes: z.array(z.string()),
        controls: z.array(z.string()),
        selectors: z.array(z.string()),
        destructive: z.array(z.string()),
    }),
});

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

const AREA_SYSTEM = `You are a precise technical writer authoring a navigation SKILL.md body for an autonomous QA agent that will read it at planning time to drive a real web app like a human user. You are given a structured DIGEST of an interaction graph that was crawled automatically. The digest is the COMPLETE and ONLY source of truth.

ABSOLUTE RULES — violating any of these makes the document useless and it will be rejected:
1. Use ONLY the facts in the digest. Never invent or guess a route, page, page title, control name, selector, transition, or destructive control. If something is not in the digest, it does not exist.
2. Copy routes, control names, and selectors VERBATIM from the digest — character for character, including casing, slashes, colons, and templated segments like ":id". Do not paraphrase, normalize, pluralize, abbreviate, or "clean up" any identifier.
3. The agent reaches a route by clicking the app's own menu, sidebar, tab, or link — NEVER by editing the URL bar. When the digest shows a control that navigates to a page ("goes to ... via <control>"), phrase the navigation step as clicking that named control. Only say "open <route>" when the digest records no in-app control that reaches it.
4. A control marked DESTRUCTIVE in the digest is destructive. List every destructive control by its exact name in the "## Destructive controls" section and state plainly it must never be actuated. NEVER write a destructive control as a step in a flow, and never describe a destructive control as safe to click. Never invent a destructive control that the digest does not flag.
5. Selectors are internal replay fallbacks for a self-healing loop. Reproduce them exactly as given; do not shorten, reorder a control's selector list, or merge selectors from different controls.

DO NOT output YAML frontmatter and DO NOT output a top-level "# " H1 heading — the caller adds the frontmatter. Start the body directly with "## ".

You MUST use these exact "## " section headings, spelled exactly, in this order. Include a heading ONLY when it has content; omit "## Destructive controls" when the digest flags none, and omit "## Selectors" when no control in the digest has selectors:
## Purpose
## Pages
## Flows
## Destructive controls (recorded — do NOT actuate)
## Selectors (internal — stripped on export)
## Safety

Section contracts:
- "## Purpose": 1–3 sentences inferred from the real pages and controls. What is this area for, and when should the agent load this skill? No filler, no marketing language, no speculation beyond the data.
- "## Pages": one "### <route>" subsection per page, using the exact route from the digest (e.g. "### /campaigns/:id"). Under each, a one-sentence purpose, then the page's key links, actions, and inputs referenced by their exact accessible names, and where notable links lead ("via <control name>"). Quote control names in double quotes exactly as given.
- "## Flows": short numbered procedures for the meaningful things a user can do here, derived from the digest's "goes to ... via" transitions — e.g. "To review a campaign: 1. click "Campaigns", 2. click "<row name>", 3. ...". Reference controls by their exact accessible name in double quotes. Never put a destructive control in a flow step.
- "## Destructive controls (recorded — do NOT actuate)": one bullet per destructive control name from the digest, verbatim, stating it is recorded and must never be actuated.
- "## Selectors (internal — stripped on export)": one bullet per key navigation/action control that has selectors, in EXACTLY this form: "- <control name>: \`<selector1>\` → \`<selector2>\`", copying the digest's selectors verbatim and joining them with " → ". This block is machine-parsed; do not reword it or add selectors absent from the digest.
- "## Safety": one sentence noting that read-only is enforced by the Sentinel harness and that the destructive controls listed are recorded but never actuated. Keep the heading exactly "## Safety".

Alongside the Markdown body you MUST return a "references" object declaring the EXACT routes, control names, selectors, and destructive control names you wrote into the body. Every item in references must come from the digest. Every route, control name, and selector you mention in the body must also appear in references, and every item in references must actually appear in the body — the two sets must match. Style: concrete and dense, GitHub-flavored Markdown, written for an agent reader.`;

const GENERAL_SYSTEM = `You are a precise technical writer authoring the general navigation SKILL.md body for an autonomous QA agent that reads it before driving a real web app like a human user. You are given a structured DIGEST of an automatically-crawled interaction graph — the COMPLETE and ONLY source of truth.

ABSOLUTE RULES:
1. Use ONLY the facts in the digest. Never invent a route, area, page, control, or skill slug.
2. Copy routes, control names, and slugs VERBATIM — character for character.
3. The agent navigates by clicking the app's own menu, sidebar, tabs, or links — NEVER by editing the URL bar.

DO NOT output YAML frontmatter and DO NOT output a top-level "# " H1 heading — the caller adds the frontmatter. Start the body directly with "## ", and follow the exact section headings and order given in the instructions.

Alongside the Markdown body you MUST return a "references" object declaring the exact routes and control names you used (drawn verbatim from the digest). The general skill declares NO selectors and NO destructive controls. Style: concrete and dense, GitHub-flavored Markdown, written for an agent reader.`;

function buildAreaPrompt(slice: AreaSlice, graph: InteractionGraph): string {
    const label = slice.area ?? "top-level";
    return `Area: "${label}" of the "${graph.repoId}" web app (base ${graph.baseUrl}).
Routes in this area: ${slice.routes.join(", ")}
Entry route(s) (the natural way in): ${slice.entryRoutes.join(", ")}

Write the SKILL.md body for this area following every rule in the system prompt. Use ONLY the DATA below.

In the DATA, each "### <route>" is a page state; the quoted string after it is the page title; "(N controls)" is the control count; "[flags: ...]" lists page flags. "links:"/"actions:"/"inputs:" list the page's controls by kind (their exact accessible names). "goes to:" lists outgoing transitions as "<target route> (via "<control name>")". "destructive:" lists controls that must never be actuated. "selectors:" gives the verbatim replay selectors per control.

Return the Markdown body, plus a references object declaring the exact routes, control names, selectors, and destructive control names you used (all drawn verbatim from this DATA).

== DATA ==
${areaDigest(slice, graph)}
== END DATA ==`;
}

function buildGeneralPrompt(graph: InteractionGraph, slices: AreaSlice[], slugs: Map<string | null, string>): string {
    return `Write the SKILL.md body for the general "how this app works" navigation skill for the "${graph.repoId}" web app (base ${graph.baseUrl}). Load this skill before driving the app: orient the agent on what the product is, its main areas and what each is for, how global navigation works, and how to move between sections. Cross-reference each area by its skill slug in backticks.

Use these exact "## " headings, in order (omit "## Global navigation (present on most pages)" if no persistent nav is given, omit "## Gotchas" if no flagged pages are given): "## Overview", "## Base & auth", "## Areas", "## Flows", "## Global navigation (present on most pages)", "## Gotchas", "## Safety". "## Base & auth" must state the Base URL and the mapped date exactly as given below. "## Areas" lists each area as "- **<area label>** — <n> page(s); see \`<slug>\`". The agent navigates by clicking in-app nav, never by editing the URL. Use ONLY the DATA below.

Return the Markdown body, plus a references object declaring the exact routes and control names you used (drawn verbatim from the DATA). Declare no selectors or destructive controls.

== DATA ==
${generalDigest(graph, slices, slugs)}
== END DATA ==`;
}

function repairBlock(errors: string[]): string {
    const numbered = errors.map((error, i) => `${i + 1}. ${error}`).join("\n");
    return `\n\nYour previous answer was REJECTED. Fix ALL of these problems and re-send the COMPLETE corrected body and references (not a diff):\n${numbered}\nRemember: every route, control name, and selector must appear verbatim in the DATA above and be listed in references; the body and references must match exactly.`;
}

/**
 * Generate, verify, and (if needed) repair a single skill body. A schema/provider
 * error from generateObject propagates immediately — the repair loop is reserved for
 * verification failures. Exhausting the retries throws {@link SkillAuthoringError}, so
 * no unverified skill ever reaches disk.
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
        const authored: AuthoredSkill = await reasoner.generateObject({
            prompt: basePrompt + repair,
            system,
            schema: authoredSkillSchema,
            maxTokens: 4000,
            telemetryLabel: attempt === 0 ? baseLabel : `${baseLabel}-repair`,
        });
        const errors = verifyAuthoredSkill(authored, index);
        if (errors.length === 0) {
            return authored.body;
        }
        if (attempt === MAX_REPAIR_ATTEMPTS) {
            throw new SkillAuthoringError(slug, attempt + 1, errors);
        }
        repair = repairBlock(errors);
    }
    // Unreachable: the loop either returns a verified body or throws above.
    throw new SkillAuthoringError(slug, MAX_REPAIR_ATTEMPTS + 1, ["unreachable"]);
}

/** Author a verified per-area skill body. The reasoner is required. */
export function authorAreaSkill(
    reasoner: Reasoner,
    slug: string,
    slice: AreaSlice,
    graph: InteractionGraph,
): Promise<string> {
    return authorWithRepair(
        reasoner,
        slug,
        AREA_SYSTEM,
        buildAreaPrompt(slice, graph),
        buildAreaIndex(slice, graph),
        "skill-area",
    );
}

/** Author a verified general "how this app works" skill body. The reasoner is required. */
export function authorGeneralSkill(
    reasoner: Reasoner,
    slug: string,
    graph: InteractionGraph,
    slices: AreaSlice[],
    slugs: Map<string | null, string>,
): Promise<string> {
    return authorWithRepair(
        reasoner,
        slug,
        GENERAL_SYSTEM,
        buildGeneralPrompt(graph, slices, slugs),
        buildGeneralIndex(graph, slices, slugs),
        "skill-general",
    );
}
