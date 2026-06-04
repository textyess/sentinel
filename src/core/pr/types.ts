/** One replayed page flow and what Sentinel observed on the PR's deployment. */
export interface FlowResult {
    url: string;
    routeArea: string | null;
    reached: boolean;
    screenshot: string | null;
    consoleErrors: string[];
    networkErrors: { url: string; status: number }[];
    blockedWrites: number;
    /** Controls present in the baseline graph but missing now / newly appeared — UI change signal. */
    controlDiff: { missing: string[]; added: string[] };
    note: string | null;
}

export interface PrRunManifest {
    pr: number;
    title: string;
    /** PR description — the "claim" side a verdict (Phase 3) reasons against. */
    body: string;
    headSha: string;
    headRef: string;
    changedFiles: string[];
    targetUrl: string;
    /** The git sha of the interaction graph used as the comparison baseline. */
    baselineSha: string | null;
    /** When/where the baseline graph was crawled — lets a verdict flag a stale/cross-env comparison. */
    baselineCreatedAt: string | null;
    baselineBaseUrl: string | null;
    /** How the replayed flows were chosen — affects how much to trust the result. */
    selectionMode: "affected-routes" | "default-spread";
    affectedRoutes: string[];
    notes: string[];
    flows: FlowResult[];
    summary: {
        flowsReplayed: number;
        flowsWithConsoleErrors: number;
        flowsWithNetworkErrors: number;
        flowsWithControlChanges: number;
        flowsUnreached: number;
        blockedWrites: number;
    };
    createdAt: string;
    video: string | null;
}
