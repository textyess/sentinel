/**
 * The interaction graph — Sentinel's persisted "understanding" of an app.
 * Nodes are page states; edges are the controls that move between them. Built by
 * the crawler, consumed later by PR replay (Phase 2) and the verdict (Phase 3).
 */

export type ControlKind = "navigation" | "input" | "action" | "unknown";

export interface ControlRef {
    /** ARIA role (explicit or inferred), e.g. "link", "button", "tab". */
    role: string;
    /** Accessible name (label/text), truncated. */
    name: string;
    /** Ranked, Playwright-resolvable selectors: role+name first, data-testid, id, CSS path. */
    selectors: string[];
    /** For navigation controls, the resolved internal path; otherwise null. */
    href: string | null;
    /** True when the accessible name matches the adapter's destructive denylist. */
    destructive: boolean;
    kind: ControlKind;
}

export interface PageNode {
    /** State signature (normalized path + structure hash) — the node id. */
    id: string;
    /** Normalized path with dynamic segments templated, e.g. "/flows/:id". */
    url: string;
    /** A real example URL that produced this node. */
    rawUrlSample: string;
    title: string;
    /** Top-level route area, e.g. "campaigns". */
    routeArea: string | null;
    controlCount: number;
    controls: ControlRef[];
    /** Relative path to a screenshot of this state, if captured. */
    screenshot: string | null;
    visitedAt: string;
    /** Notes such as "auth-wall", "error", "opaque-canvas". */
    flagged: string[];
}

export interface EdgeVia {
    role: string;
    name: string;
    selector: string;
    kind: ControlKind;
}

export interface GraphEdge {
    from: string;
    to: string;
    via: EdgeVia;
    transition: "navigate" | "in-page";
}

export interface CoverageReport {
    routesSeeded: string[];
    routesReached: string[];
    routesUnreached: string[];
    areasReached: string[];
    nodeCount: number;
    edgeCount: number;
    blockedWrites: number;
    notes: string[];
}

export interface InteractionGraph {
    repoId: string;
    baseUrl: string;
    /** Local repo HEAD sha when the crawl ran, for diffing across PRs. */
    gitSha: string | null;
    createdAt: string;
    nodes: Record<string, PageNode>;
    edges: GraphEdge[];
    coverage: CoverageReport;
}
