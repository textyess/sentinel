import type { InteractionGraph } from "../graph/types";
import type { Reasoner } from "../reasoner/types";

/** Compact the graph into a token-efficient, information-dense digest for the model. */
function digestGraph(graph: InteractionGraph): string {
    const outgoing = new Map<string, string[]>();
    for (const edge of graph.edges) {
        const target = graph.nodes[edge.to];
        const label = `-> ${target ? target.url : edge.to} (via "${edge.via.name || edge.via.role}")`;
        const list = outgoing.get(edge.from) ?? [];
        list.push(label);
        outgoing.set(edge.from, list);
    }

    const nodes = Object.values(graph.nodes).sort(
        (a, b) => (a.routeArea ?? "").localeCompare(b.routeArea ?? "") || a.url.localeCompare(b.url),
    );

    const lines: string[] = [
        `App: ${graph.repoId}  Base: ${graph.baseUrl}`,
        `Areas: ${graph.coverage.areasReached.join(", ")}`,
        `Pages: ${graph.coverage.nodeCount}  Navigation edges: ${graph.coverage.edgeCount}`,
        "",
    ];

    for (const node of nodes) {
        const flags = node.flagged.length ? `  FLAGGED:${node.flagged.join(",")}` : "";
        const title = node.title ? ` ${JSON.stringify(node.title)}` : "";
        lines.push(`### ${node.url}  [${node.routeArea ?? "-"}]${title} (${node.controlCount} controls)${flags}`);

        const nav = (outgoing.get(node.id) ?? []).slice(0, 14);
        if (nav.length > 0) {
            lines.push(`  nav: ${nav.join("; ")}`);
        }
        const actions = uniqueNames(node.controls.filter((c) => c.kind === "action")).slice(0, 16);
        if (actions.length > 0) {
            lines.push(`  actions: ${actions.join(", ")}`);
        }
        const inputs = uniqueNames(node.controls.filter((c) => c.kind === "input")).slice(0, 10);
        if (inputs.length > 0) {
            lines.push(`  inputs: ${inputs.join(", ")}`);
        }
    }

    return lines.join("\n");
}

function uniqueNames(controls: { name: string }[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const control of controls) {
        const name = control.name.trim();
        if (name && !seen.has(name)) {
            seen.add(name);
            out.push(name);
        }
    }
    return out;
}

const SYSTEM =
    "You are a precise technical writer documenting how a web app works for a new teammate. " +
    "Use ONLY the data you are given — never invent features, pages, or controls. " +
    "Be concrete: reference real page paths and control names from the data.";

/**
 * Turn the autonomously-mapped interaction graph into a human-readable Markdown
 * site map: what the product is, its main areas, how navigation works, and the
 * notable controls per page. Pure synthesis over the static graph — no browsing.
 */
export async function synthesizeSiteMap(graph: InteractionGraph, reasoner: Reasoner): Promise<string> {
    const prompt = `Below is an interaction graph that was autonomously mapped from the "${graph.repoId}" web app (base ${graph.baseUrl}). Each "### path" is a page; "nav:" lists where its links go; "actions:" and "inputs:" list its interactive controls.

Write a clear, well-structured Markdown site map a developer can use to understand the product and find their way around. Include:
1. A short overview of what the app is for (infer from the areas and pages).
2. The main areas, grouped, and what each is for.
3. How navigation is structured and how to move between key pages.
4. For the most important pages: the path, its purpose, and a few key controls.
5. Anything notable — dual versions (e.g. flows vs flows2), pages flagged as having no controls or an opaque canvas, etc.

Do not speculate beyond the data. Interaction graph:

${digestGraph(graph)}`;

    return reasoner.generateText({ prompt, system: SYSTEM, maxTokens: 4000, telemetryLabel: "sitemap" });
}
