import type { InteractionGraph } from "../graph/types";
import { persistentNav } from "./digest";
import type { AreaSlice } from "./group";
import type { AuthoredSkill } from "./types";

/**
 * Pure, code-based verification of an LLM-authored skill against the interaction
 * graph it was authored from. Every checked fact is a finite exact-match property of
 * the graph (a route, a control name, a selector string, a destructive flag), so this
 * needs no second LLM. The heading constants are the single source of truth shared
 * with the authoring prompt and the portable exporter, which key off them literally.
 */

export const SAFETY_HEADING = "## Safety";
export const SELECTORS_HEADING = "## Selectors (internal — stripped on export)";
export const DESTRUCTIVE_HEADING = "## Destructive controls (recorded — do NOT actuate)";
export const FLOWS_HEADING = "## Flows";
export const REQUIRED_AREA_HEADINGS = ["## Purpose", "## Pages", FLOWS_HEADING, SAFETY_HEADING];
export const REQUIRED_GENERAL_HEADINGS = ["## Overview", "## Base & auth", "## Areas", SAFETY_HEADING];

export interface AreaIndex {
    kind: "area";
    /** Area routes + routes reachable from the area (what references.routes may cite). */
    routes: Set<string>;
    /** Every route in the whole graph — the bar for a route merely mentioned in prose. */
    allRoutes: Set<string>;
    controls: Set<string>;
    selectors: Set<string>;
    /** Control name -> the set of verbatim backtick selector chains observed for it (a name can
     * recur across pages with different chains, so any one of them is a valid body line). */
    selectorsByControl: Map<string, Set<string>>;
    destructive: Set<string>;
}

export interface GeneralIndex {
    kind: "general";
    routes: Set<string>;
    controls: Set<string>;
    slugs: Set<string>;
}

export function buildAreaIndex(slice: AreaSlice, graph: InteractionGraph): AreaIndex {
    const routes = new Set<string>(slice.routes);
    const allRoutes = new Set<string>();
    const controls = new Set<string>();
    const selectors = new Set<string>();
    const selectorsByControl = new Map<string, Set<string>>();
    const destructive = new Set<string>(slice.destructive);
    const nodeIds = new Set(slice.nodes.map((n) => n.id));

    for (const node of Object.values(graph.nodes)) {
        allRoutes.add(node.url);
    }
    for (const node of slice.nodes) {
        for (const control of node.controls) {
            const name = control.name.trim();
            if (name) {
                controls.add(name);
            }
            for (const selector of control.selectors) {
                selectors.add(selector);
            }
            const navigational = control.kind === "navigation" || control.kind === "action";
            if (navigational && name && control.selectors.length > 0) {
                const chain = control.selectors.map((s) => `\`${s}\``).join(" → ");
                const set = selectorsByControl.get(name) ?? new Set<string>();
                set.add(chain);
                selectorsByControl.set(name, set);
            }
        }
    }
    // Legitimate cross-area links and persistent chrome genuinely appear on these pages,
    // so allow them as references rather than triggering needless repair churn.
    for (const edge of graph.edges) {
        if (nodeIds.has(edge.from)) {
            const target = graph.nodes[edge.to];
            if (target) {
                routes.add(target.url);
            }
        }
    }
    for (const name of persistentNav(graph)) {
        controls.add(name);
    }
    return { kind: "area", routes, allRoutes, controls, selectors, selectorsByControl, destructive };
}

export function buildGeneralIndex(
    graph: InteractionGraph,
    slices: AreaSlice[],
    slugs: Map<string | null, string>,
): GeneralIndex {
    const routes = new Set<string>();
    for (const slice of slices) {
        for (const route of slice.routes) {
            routes.add(route);
        }
    }
    const controls = new Set<string>();
    for (const node of Object.values(graph.nodes)) {
        for (const control of node.controls) {
            const name = control.name.trim();
            if (name) {
                controls.add(name);
            }
        }
    }
    const slugSet = new Set<string>();
    for (const slug of slugs.values()) {
        slugSet.add(slug);
    }
    return { kind: "general", routes, controls, slugs: slugSet };
}

/** A short, sorted, capped rendering of an allowed-token set for repair feedback. */
function sortedList(set: Set<string>, cap = 40): string {
    const arr = Array.from(set).sort();
    const shown = arr.slice(0, cap).join(", ");
    return arr.length > cap ? `${shown}, … (${arr.length} total)` : shown;
}

/** Headings present as their own line (avoids substring false matches). */
function headingSet(body: string): Set<string> {
    return new Set(body.split("\n").map((line) => line.trim()));
}

function requireHeadings(headings: Set<string>, required: string[], errors: string[]): void {
    for (const heading of required) {
        if (!headings.has(heading)) {
            errors.push(`Missing required section: ${heading}.`);
        }
    }
}

/** "### <route>" page-heading tokens (first whitespace-delimited token after the marker). */
function pageHeadings(body: string): string[] {
    const out: string[] = [];
    for (const line of body.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.startsWith("### ")) {
            const token = trimmed.slice(4).trim().split(/\s+/)[0];
            if (token) {
                out.push(token);
            }
        }
    }
    return out;
}

/** Parse a "- <name>: `sel` → `sel`" line, tolerating colons inside the control name. */
function parseSelectorLine(line: string): { name: string; chain: string } | null {
    const trimmed = line.trim();
    if (!trimmed.startsWith("- ")) {
        return null;
    }
    const rest = trimmed.slice(2);
    const idx = rest.indexOf(": `");
    if (idx === -1) {
        return null;
    }
    const name = rest.slice(0, idx).replace(/^"|"$/g, "").trim();
    const chain = rest.slice(idx + 2).trim();
    return { name, chain };
}

/** The text lines under a "## " section heading (until the next "## "). */
function linesUnder(body: string, heading: string): string[] {
    const out: string[] = [];
    let inSection = false;
    for (const line of body.split("\n")) {
        if (line.trim().startsWith("## ")) {
            inSection = line.trim() === heading;
            continue;
        }
        if (inSection) {
            out.push(line);
        }
    }
    return out;
}

/** Backtick-wrapped tokens on lines under a given "## " section heading. */
function backticksUnder(body: string, heading: string): string[] {
    const out: string[] = [];
    for (const line of linesUnder(body, heading)) {
        for (const match of line.matchAll(/`([^`]+)`/g)) {
            const token = match[1];
            if (token) {
                out.push(token);
            }
        }
    }
    return out;
}

/** Double-quoted tokens on lines under a given "## " section heading. */
function quotedTokensUnder(body: string, heading: string): string[] {
    const out: string[] = [];
    for (const line of linesUnder(body, heading)) {
        for (const match of line.matchAll(/"([^"]+)"/g)) {
            const token = match[1];
            if (token) {
                out.push(token);
            }
        }
    }
    return out;
}

/** Path-like tokens written in prose (outside inline code and the selectors section). */
function routeTokens(body: string): string[] {
    const out: string[] = [];
    let inSelectors = false;
    for (const line of body.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.startsWith("## ")) {
            inSelectors = trimmed === SELECTORS_HEADING;
            continue;
        }
        if (inSelectors) {
            continue;
        }
        const withoutCode = line.replace(/`[^`]*`/g, " ");
        for (const match of withoutCode.matchAll(/(?:^|[\s(])(\/[A-Za-z0-9][A-Za-z0-9/_:.-]*)/g)) {
            const raw = match[1];
            if (!raw) {
                continue;
            }
            const token = raw.replace(/[.,;:)\]]+$/, "");
            if (token.length > 1) {
                out.push(token);
            }
        }
    }
    return out;
}

function verifyStructure(body: string, errors: string[]): void {
    if (body.startsWith("---")) {
        errors.push("Body must not start with YAML frontmatter ('---'); the caller adds it.");
    }
    if (body.startsWith("# ") || body.includes("\n# ")) {
        errors.push("Body must not contain a top-level '# ' heading.");
    }
}

function verifyArea(authored: AuthoredSkill, index: AreaIndex, errors: string[]): void {
    const { body, references } = authored;

    for (const selector of references.selectors) {
        if (!index.selectors.has(selector)) {
            errors.push(`Selector \`${selector}\` is not in the data; copy selectors verbatim.`);
        }
    }
    // Destructive integrity is the safety-critical check: the body's destructive set must equal
    // the graph's, each must be listed under the destructive heading, and none may appear as a flow step.
    const destructiveSection = linesUnder(body, DESTRUCTIVE_HEADING).join("\n");
    for (const name of index.destructive) {
        if (!references.destructive.includes(name)) {
            errors.push(`Destructive control "${name}" must be listed in the '${DESTRUCTIVE_HEADING}' section.`);
        }
        if (!destructiveSection.includes(name)) {
            errors.push(`Destructive control "${name}" must appear as a bullet under '${DESTRUCTIVE_HEADING}'.`);
        }
    }
    for (const name of references.destructive) {
        if (!index.destructive.has(name)) {
            errors.push(`Invented destructive control "${name}" — it is not flagged in the data.`);
        }
    }
    for (const token of quotedTokensUnder(body, FLOWS_HEADING)) {
        if (index.destructive.has(token)) {
            errors.push(`Destructive control "${token}" must not be used as a step in '${FLOWS_HEADING}'.`);
        }
    }

    for (const route of references.routes) {
        if (!body.includes(route)) {
            errors.push(`Declared route '${route}' is not used in the body.`);
        }
    }
    for (const heading of pageHeadings(body)) {
        if (!index.routes.has(heading)) {
            errors.push(
                `Page heading '### ${heading}' is not a real route. Allowed routes: ${sortedList(index.routes)}.`,
            );
        }
    }
    for (const token of routeTokens(body)) {
        if (!index.allRoutes.has(token)) {
            errors.push(`Route '${token}' mentioned in the body is not a real route in the app.`);
        }
    }

    // Every backticked token under the selectors heading must be a real selector (the set is finite
    // and known, so an exact membership test beats guessing what "looks like" a selector).
    for (const token of backticksUnder(body, SELECTORS_HEADING)) {
        if (!index.selectors.has(token)) {
            errors.push(`Body uses selector \`${token}\` that is not in the data.`);
        }
    }
    for (const line of body.split("\n")) {
        const parsed = parseSelectorLine(line);
        if (!parsed || !line.includes("`")) {
            continue;
        }
        const valid = index.selectorsByControl.get(parsed.name);
        if (valid === undefined) {
            continue;
        }
        if (!valid.has(parsed.chain)) {
            errors.push(
                `Selector line for "${parsed.name}" must copy a chain from the data verbatim: ${Array.from(valid).join(" | ")}.`,
            );
        }
    }

    const headings = headingSet(body);
    requireHeadings(headings, REQUIRED_AREA_HEADINGS, errors);
    if (index.selectors.size > 0) {
        requireHeadings(headings, [SELECTORS_HEADING], errors);
    }
    if (index.destructive.size > 0) {
        requireHeadings(headings, [DESTRUCTIVE_HEADING], errors);
    }
}

function verifyGeneral(authored: AuthoredSkill, index: GeneralIndex, errors: string[]): void {
    const { body, references } = authored;
    if (references.selectors.length > 0) {
        errors.push("The general navigation skill must not declare selectors.");
    }
    if (references.destructive.length > 0) {
        errors.push("The general navigation skill must not declare destructive controls.");
    }
    for (const route of references.routes) {
        if (!body.includes(route)) {
            errors.push(`Declared route '${route}' is not used in the body.`);
        }
    }
    for (const slug of backticksUnder(body, "## Areas")) {
        if (!index.slugs.has(slug)) {
            errors.push(
                `Area cross-reference \`${slug}\` is not a real skill slug. Allowed: ${sortedList(index.slugs)}.`,
            );
        }
    }
    requireHeadings(headingSet(body), REQUIRED_GENERAL_HEADINGS, errors);
}

/**
 * Verify an authored skill against its ground-truth index. Returns the list of
 * violations (empty means it passed); each string is human- and model-readable and is
 * fed back verbatim as repair feedback.
 */
export function verifyAuthoredSkill(authored: AuthoredSkill, index: AreaIndex | GeneralIndex): string[] {
    const errors: string[] = [];
    verifyStructure(authored.body, errors);

    for (const route of authored.references.routes) {
        if (!index.routes.has(route)) {
            errors.push(`Route '${route}' is not in the data. Allowed routes: ${sortedList(index.routes)}.`);
        }
    }
    for (const control of authored.references.controls) {
        if (!index.controls.has(control)) {
            errors.push(`Control "${control}" is not in the data. Allowed controls: ${sortedList(index.controls)}.`);
        } else if (!authored.body.includes(control)) {
            errors.push(`Declared control "${control}" is not used in the body.`);
        }
    }

    if (index.kind === "area") {
        verifyArea(authored, index, errors);
    } else {
        verifyGeneral(authored, index, errors);
    }
    return errors;
}
