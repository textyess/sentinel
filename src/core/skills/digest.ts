import type { ControlKind, ControlRef, InteractionGraph, PageNode } from "../graph/types";
import type { AreaSlice } from "./group";

/**
 * Pure graph → text-digest serializers. These produce the "DATA" block fed to the
 * authoring LLM, and the shared helpers (persistent-nav / flagged-page detection,
 * outgoing edges) reused by the verifier. No LLM, no app-specific strings.
 */

/** Distinct accessible names of one control kind on a page, capped. */
export function uniqueNames(controls: ControlRef[], kind: ControlKind, cap: number): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const control of controls) {
        if (control.kind !== kind) {
            continue;
        }
        const name = control.name.trim();
        if (name && !seen.has(name)) {
            seen.add(name);
            out.push(name);
            if (out.length >= cap) {
                break;
            }
        }
    }
    return out;
}

export interface Outgoing {
    url: string;
    via: string;
}

/** Map node id -> the pages it navigates to (resolved through the graph). */
export function outgoingByNode(graph: InteractionGraph): Map<string, Outgoing[]> {
    const map = new Map<string, Outgoing[]>();
    for (const edge of graph.edges) {
        const target = graph.nodes[edge.to];
        if (!target) {
            continue;
        }
        const list = map.get(edge.from) ?? [];
        list.push({ url: target.url, via: edge.via.name || edge.via.role });
        map.set(edge.from, list);
    }
    return map;
}

/** Navigation controls present on at least half the pages — the app's persistent chrome. */
export function persistentNav(graph: InteractionGraph): string[] {
    const nodes = Object.values(graph.nodes);
    if (nodes.length <= 1) {
        return [];
    }
    const counts = new Map<string, number>();
    for (const node of nodes) {
        const namesOnPage = new Set<string>();
        for (const control of node.controls) {
            if (control.kind === "navigation" && control.name.trim()) {
                namesOnPage.add(control.name.trim());
            }
        }
        for (const name of namesOnPage) {
            counts.set(name, (counts.get(name) ?? 0) + 1);
        }
    }
    const threshold = Math.ceil(nodes.length / 2);
    return Array.from(counts.entries())
        .filter(([, count]) => count >= threshold)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 16)
        .map(([name]) => name);
}

export function flaggedPages(graph: InteractionGraph): string[] {
    const out: string[] = [];
    for (const node of Object.values(graph.nodes)) {
        if (node.flagged.length > 0) {
            out.push(`${node.url}: ${node.flagged.join(", ")}`);
        }
    }
    return out;
}

/** The selector lines for a page's key controls, in the verbatim form the body must reproduce. */
function selectorDigestLines(node: PageNode): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const control of node.controls) {
        if (control.kind !== "navigation" && control.kind !== "action") {
            continue;
        }
        const name = control.name.trim();
        if (!name || control.selectors.length === 0 || seen.has(name)) {
            continue;
        }
        seen.add(name);
        out.push(`    - ${name}: ${control.selectors.map((s) => `\`${s}\``).join(" → ")}`);
    }
    return out;
}

/** Serialize one route area's observed pages into the DATA block for the area authoring prompt. */
export function areaDigest(slice: AreaSlice, graph: InteractionGraph): string {
    const outgoing = outgoingByNode(graph);
    const blocks: string[] = [];
    for (const node of slice.nodes) {
        const title = node.title ? `  "${node.title}"` : "";
        const flags = node.flagged.length > 0 ? node.flagged.join(", ") : "none";
        const lines: string[] = [`### ${node.url}${title}  (${node.controlCount} controls)  [flags: ${flags}]`];

        const links = uniqueNames(node.controls, "navigation", 30);
        if (links.length > 0) {
            lines.push(`  links: ${links.map((n) => `"${n}"`).join(", ")}`);
        }
        const actions = uniqueNames(node.controls, "action", 30);
        if (actions.length > 0) {
            lines.push(`  actions: ${actions.map((n) => `"${n}"`).join(", ")}`);
        }
        const inputs = uniqueNames(node.controls, "input", 20);
        if (inputs.length > 0) {
            lines.push(`  inputs: ${inputs.map((n) => `"${n}"`).join(", ")}`);
        }
        const goes = (outgoing.get(node.id) ?? []).map((o) => `${o.url} (via "${o.via}")`);
        if (goes.length > 0) {
            lines.push(`  goes to: ${goes.join("; ")}`);
        }
        const destructive = Array.from(
            new Set(node.controls.filter((c) => c.destructive && c.name.trim()).map((c) => c.name.trim())),
        );
        if (destructive.length > 0) {
            lines.push(`  destructive: ${destructive.map((n) => `"${n}"`).join(", ")}`);
        }
        const selectors = selectorDigestLines(node);
        if (selectors.length > 0) {
            lines.push("  selectors:");
            lines.push(...selectors);
        }
        blocks.push(lines.join("\n"));
    }
    return blocks.join("\n\n");
}

/** Serialize the whole-app overview into the DATA block for the general authoring prompt. */
export function generalDigest(graph: InteractionGraph, slices: AreaSlice[], slugs: Map<string | null, string>): string {
    const lines: string[] = [
        `App: ${graph.repoId}  Base: ${graph.baseUrl}`,
        `Mapped: ${graph.createdAt}${graph.gitSha ? ` (git ${graph.gitSha})` : ""}`,
        "",
        "Areas:",
    ];
    for (const slice of slices) {
        const label = slice.area ?? "top-level";
        const slug = slugs.get(slice.area) ?? "";
        lines.push(`- ${label} — ${slice.nodes.length} page(s); slug ${slug}`);
    }
    const persistent = persistentNav(graph);
    if (persistent.length > 0) {
        lines.push("", `Global navigation (persistent): ${persistent.map((n) => `"${n}"`).join(", ")}`);
    }
    const flagged = flaggedPages(graph);
    if (flagged.length > 0) {
        lines.push("", "Flagged pages:");
        for (const note of flagged) {
            lines.push(`- ${note}`);
        }
    }
    return lines.join("\n");
}
