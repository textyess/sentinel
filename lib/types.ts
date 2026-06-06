// DTOs mirroring Sentinel's server API (src/server/types.ts + api.ts). Kept as a
// thin, explicit copy so the frontend has no build-time coupling to the backend.

export type AdapterKind = "textyess" | "generic";

export type RunStatus = "queued" | "running" | "passed" | "failed" | "uncertain" | "blocked" | "errored";

export type Outcome = "pass" | "fail" | "uncertain";
export type Confidence = "high" | "medium" | "low";

export interface Health {
    ghAuthOk: boolean;
    llmCredOk: boolean;
    pollerRunning: boolean;
}

export interface Verdict {
    outcome: Outcome;
    confidence: Confidence;
    summary: string;
    evidence: string[];
}

export interface ProjectView {
    id: string;
    repo: string;
    displayName: string;
    adapterKind: AdapterKind;
    previewEnvIncludes: string;
    mentionHandle: string;
    adapter: unknown;
    baselineUrl?: string | null;
    createdAt: string;
    graphPresent: boolean;
    credsConfigured: boolean;
}

// POST /api/projects returns the base record — graphPresent/credsConfigured are
// derived only by GET /api/projects, so the create response omits them.
export type ProjectRecord = Omit<ProjectView, "graphPresent" | "credsConfigured">;

export interface RunSummary {
    runId: string;
    projectId: string;
    repo: string;
    pr: number;
    title: string;
    outcome: Outcome | null;
    confidence: Confidence | null;
    summary: string;
    videoUrl: string | null;
    createdAt: string;
    status: RunStatus;
}

export interface EnvPresence {
    keys: Record<string, { set: boolean }>;
    values: Record<string, string>;
}

export interface TriggerResult {
    runId: string;
    status: string;
}

// ---- register-project payloads ---------------------------------------------

export interface GenericAuthInput {
    loginPath: string;
    emailLabel: string;
    passwordLabel: string;
    submitNamePattern: string;
    authenticatedUrlPattern: string;
    publicRoutes: string[];
}

export interface GenericAdapterInput {
    auth: GenericAuthInput;
    emailEnv: string;
    passwordEnv: string;
    previewEnvIncludes: string;
    pagesPrefix?: string;
    allowedMutationPatterns: string[];
}

export interface CreateProjectInput {
    repo: string;
    adapterKind: AdapterKind;
    previewEnvIncludes: string;
    mentionHandle: string;
    baselineUrl: string | null;
    adapter: GenericAdapterInput | null;
}

// ---- SSE live-run events ----------------------------------------------------

export type LogLevel = "info" | "success" | "error" | "warn" | "debug";

export interface ProgressEvent {
    level: LogLevel;
    message: string;
    at: string;
}

export interface CrawlCoverage {
    nodeCount: number;
    edgeCount: number;
    routesReached: number;
    routesUnreached: number;
}

export type DoneEvent =
    | { kind?: undefined; verdict: Verdict; videoUrl: string | null }
    | { kind: "crawl"; coverage: CrawlCoverage; graphPresent: true };

export type RunKind = "verify" | "crawl";
