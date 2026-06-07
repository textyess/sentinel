// DTOs mirroring Sentinel's server API (src/server/types.ts + api.ts). Kept as a
// thin, explicit copy so the frontend has no build-time coupling to the backend.

// "generic" (config-driven) or any registered built-in kind — the dashboard fetches
// the available kinds from /api/adapters, so this stays an open string.
export type AdapterKind = string;

export interface Adapters {
    kinds: string[];
}

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
    /** True when a generated skill pack exists (so it can be exported). */
    skillsPresent: boolean;
    /** False for a public (no-login) project — the UI then shows "no login needed". */
    authRequired: boolean;
}

// POST /api/projects returns the base record — graphPresent/credsConfigured/skillsPresent
// are derived only by GET /api/projects, so the create response omits them.
export type ProjectRecord = Omit<ProjectView, "graphPresent" | "credsConfigured" | "skillsPresent">;

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
    // When false, the app is public — no login, no credentials. Defaults to true.
    authRequired?: boolean;
    // Credential env-var NAMES — optional; the server derives them from the repo slug
    // when omitted, so the registration form no longer asks for them.
    emailEnv?: string;
    passwordEnv?: string;
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

// ---- auto-detect onboarding -------------------------------------------------

export interface AutodetectFieldMeta {
    confidence: Confidence;
    source: string;
}

// The server emits its full GenericProjectConfig as the proposal's adapter (a superset
// of the registration input), so model that wire shape honestly. The dialog reads only
// auth.*, pagesPrefix, and allowedMutationPatterns; the extra fields are carried through.
export interface AutodetectAdapter extends GenericAdapterInput {
    knownRoutes?: string[];
    productionMarkers?: string[];
    destructiveControlPatterns?: string[];
}

export interface AutodetectProposal {
    repo: string;
    baselineUrl: string;
    previewEnvIncludes: string;
    /** False when the detector found the app needs no login. */
    authRequired: boolean;
    adapter: AutodetectAdapter;
    /** Keyed by dotted field path, e.g. "auth.loginPath" / "allowedMutationPatterns". */
    fieldMeta: Record<string, AutodetectFieldMeta>;
    notes: string[];
}

export type DoneEvent =
    | { kind?: undefined; verdict: Verdict; videoUrl: string | null }
    | { kind: "crawl"; coverage: CrawlCoverage; graphPresent: true }
    | { kind: "skills"; skillCount: number; areas: number }
    | { kind: "autodetect"; proposal: AutodetectProposal };

export type RunKind = "verify" | "crawl" | "autodetect" | "skills";

// ---- run report (a verify run's manifest, sanitized for the browser) --------

export type StepAction = "navigate" | "click" | "type" | "select" | "hover" | "scroll" | "assert" | "wait";

export interface PlanStep {
    action: StepAction;
    /** Human description of the target (a route for navigate, a control description otherwise). */
    target: string;
    /** Value to type/select, when applicable. */
    value: string | null;
    /** What should be visibly true after this step. */
    expect: string;
    /** Why this step exists — tied to the PR's change. */
    reason: string;
}

export interface TestPlan {
    /** What the plan verifies about the PR. */
    goal: string;
    /** Route to start from. */
    startRoute: string;
    steps: PlanStep[];
    notes: string[];
}

export type StepStatus = "ok" | "failed" | "blocked" | "skipped";

export interface NetworkError {
    url: string;
    status: number;
}

export type DiscrepancyKind = "selector-stale" | "missing-control" | "destination-drift";

export interface SkillDiscrepancy {
    kind: DiscrepancyKind;
    route: string;
    skillSlug: string;
    detail: string;
}

export interface StepResultView {
    index: number;
    step: PlanStep;
    status: StepStatus;
    /** What Sentinel observed (or why it failed / was blocked). */
    observation: string;
    screenshotUrl: string | null;
    consoleErrors: string[];
    networkErrors: NetworkError[];
    /** Skill-vs-live divergences noticed on this step; omitted when there were none. */
    discrepancies?: SkillDiscrepancy[];
}

export interface RunManifestView {
    runId: string;
    projectId: string;
    repo: string;
    pr: number;
    title: string;
    body: string;
    headSha: string;
    headRef: string;
    targetUrl: string;
    changedFiles: string[];
    affectedRoutes: string[];
    /** True when the run never wrote (read-only enforced). */
    readOnly: boolean;
    blockedWrites: number;
    model: string;
    plan: TestPlan;
    results: StepResultView[];
    verdict: Verdict;
    videoUrl: string | null;
    createdAt: string;
    status: RunStatus;
}
