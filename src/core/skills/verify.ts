import type { InteractionGraph } from "../graph/types";
import type { AreaSlice } from "./group";

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
// Only the LLM-authored sections are required; Selectors/Destructive/Safety are appended by code.
export const REQUIRED_AREA_HEADINGS = ["## Purpose", "## Pages", FLOWS_HEADING];
export const REQUIRED_GENERAL_HEADINGS = ["## Overview", "## Base & auth", "## Areas"];

export interface AreaIndex {
    kind: "area";
    /** Area routes + routes reachable from the area's pages (valid to mention in prose). */
    routes: Set<string>;
    /** Every route in the whole graph — the bar for a route merely mentioned in prose. */
    allRoutes: Set<string>;
    /** Destructive control names — the LLM-authored Flows must not use any of these as a step. */
    destructive: Set<string>;
}

export interface GeneralIndex {
    kind: "general";
    routes: Set<string>;
    slugs: Set<string>;
}

export function buildAreaIndex(slice: AreaSlice, graph: InteractionGraph): AreaIndex {
    const routes = new Set<string>(slice.routes);
    const allRoutes = new Set<string>();
    const destructive = new Set<string>(slice.destructive);
    const nodeIds = new Set(slice.nodes.map((n) => n.id));

    for (const node of Object.values(graph.nodes)) {
        allRoutes.add(node.url);
    }
    // Cross-area links reachable from this area's pages are legitimate route mentions.
    for (const edge of graph.edges) {
        if (nodeIds.has(edge.from)) {
            const target = graph.nodes[edge.to];
            if (target) {
                routes.add(target.url);
            }
        }
    }
    return { kind: "area", routes, allRoutes, destructive };
}

export function buildGeneralIndex(graph: InteractionGraph, slugs: Map<string | null, string>): GeneralIndex {
    const routes = new Set<string>();
    for (const node of Object.values(graph.nodes)) {
        routes.add(node.url);
    }
    const slugSet = new Set<string>();
    for (const slug of slugs.values()) {
        slugSet.add(slug);
    }
    return { kind: "general", routes, slugs: slugSet };
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

function verifyArea(body: string, index: AreaIndex, errors: string[]): void {
    // Safety-critical: a destructive control must never be written as a flow step (the code
    // appends the canonical destructive list separately; the model only writes the prose flows).
    for (const token of quotedTokensUnder(body, FLOWS_HEADING)) {
        if (index.destructive.has(token)) {
            errors.push(`Destructive control "${token}" must not be used as a step in '${FLOWS_HEADING}'.`);
        }
    }
    // A route-shaped "### /path" page heading must be a real route (anti-hallucination); the model
    // may freely use "### " for non-route subsections (e.g. "### Navigate").
    for (const heading of pageHeadings(body)) {
        if (heading.startsWith("/") && !index.routes.has(heading)) {
            errors.push(
                `Page heading '### ${heading}' is not a real route. Allowed routes: ${sortedList(index.routes)}.`,
            );
        }
    }
    // Any path-like token written in prose must be a real route somewhere in the app.
    for (const token of routeTokens(body)) {
        if (!index.allRoutes.has(token)) {
            errors.push(`Route '${token}' mentioned in the body is not a real route in the app.`);
        }
    }
    requireHeadings(headingSet(body), REQUIRED_AREA_HEADINGS, errors);
}

function verifyGeneral(body: string, index: GeneralIndex, errors: string[]): void {
    for (const token of routeTokens(body)) {
        if (!index.routes.has(token)) {
            errors.push(`Route '${token}' mentioned in the body is not a real route in the app.`);
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
 * Verify an authored skill body against its ground-truth index. Checks are purely
 * over the prose the model wrote (no declared-references step, which proved a brittle
 * source of false failures): routes it mentions must be real, no destructive control
 * may appear as a flow step, and the required sections must be present. Returns the
 * violations (empty = pass); each string is fed back verbatim as repair feedback.
 */
export function verifyAuthoredSkill(body: string, index: AreaIndex | GeneralIndex): string[] {
    const errors: string[] = [];
    verifyStructure(body, errors);
    if (index.kind === "area") {
        verifyArea(body, index, errors);
    } else {
        verifyGeneral(body, index, errors);
    }
    return errors;
}
