import type { InteractionGraph, PageNode } from "../graph/types";

/** One route area's slice of the interaction graph — the unit a per-area skill is rendered from. */
export interface AreaSlice {
    /** Top-level route area (PageNode.routeArea); null buckets the rootless pages together. */
    area: string | null;
    /** Pages in this area, shallowest path first then alphabetical. */
    nodes: PageNode[];
    /** Distinct templated paths in the area, e.g. ["/campaigns", "/campaigns/:id"]. */
    routes: string[];
    /** The shallowest route(s) — the natural way into the area. */
    entryRoutes: string[];
    /** Distinct destructive control names seen in the area (recorded, never actuated). */
    destructive: string[];
}

/** Path depth = number of non-empty segments, so "/" is 0 and "/a/b" is 2. */
function depth(routePath: string): number {
    return routePath.split("/").filter(Boolean).length;
}

/**
 * Partition the graph by route area. Nodes carry their area (the first literal path
 * segment); the rootless bucket (area === null) collects the home page and any
 * id-rooted paths. Each slice is self-contained so a skill can be rendered from it
 * without re-walking the whole graph.
 */
export function groupByArea(graph: InteractionGraph): AreaSlice[] {
    const byArea = new Map<string | null, PageNode[]>();
    for (const node of Object.values(graph.nodes)) {
        const list = byArea.get(node.routeArea) ?? [];
        list.push(node);
        byArea.set(node.routeArea, list);
    }

    const slices: AreaSlice[] = [];
    for (const [area, nodes] of byArea) {
        const sorted = [...nodes].sort((a, b) => depth(a.url) - depth(b.url) || a.url.localeCompare(b.url));
        const routes = Array.from(new Set(sorted.map((n) => n.url)));
        const minDepth = routes.length > 0 ? Math.min(...routes.map(depth)) : 0;
        const entryRoutes = routes.filter((route) => depth(route) === minDepth);
        // Trim names so the destructive set matches the trimmed names everywhere else
        // (digest, index) — a stray-whitespace aria-label must not desync verification.
        const destructive = Array.from(
            new Set(
                sorted.flatMap((n) =>
                    n.controls.filter((c) => c.destructive && c.name.trim()).map((c) => c.name.trim()),
                ),
            ),
        );
        slices.push({ area, nodes: sorted, routes, entryRoutes, destructive });
    }

    // Stable, readable order: named areas alphabetically, the rootless bucket last.
    return slices.sort((a, b) => {
        if (a.area === null) {
            return 1;
        }
        if (b.area === null) {
            return -1;
        }
        return a.area.localeCompare(b.area);
    });
}
