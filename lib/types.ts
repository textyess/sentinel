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

// ---- GitHub device-flow login (Settings → Connect GitHub) --------------------

export type GithubLoginFlow =
    | { state: "idle" }
    | { state: "pending"; userCode: string; verificationUri: string; expiresAt: string }
    | { state: "connected"; login: string | null }
    | { state: "error"; message: string };

export interface GithubAuthView {
    flow: GithubLoginFlow;
    /** Whether GH_TOKEN is currently set (via the flow, manual paste, or the host env). */
    tokenSet: boolean;
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

// How to start the app locally for repos with no PR preview deployment. Secrets are
// referenced by env-var NAME (resolved from Sentinel's managed env at launch), never
// stored raw — mirroring the credential env-var convention.
export interface RunRecipeInput {
    installCmd?: string;
    runCmd: string;
    port: number;
    readyPath?: string;
    /** Non-secret env literals (e.g. NEXT_PUBLIC_API_URL). */
    env?: Record<string, string>;
    /** Names of Sentinel-managed env vars injected at launch (secrets). */
    secretEnv?: string[];
}

// Proposed by GET-less POST /api/scan-recipe — a clone-free guess at how to start the repo.
export interface RunRecipeProposal {
    installCmd: string;
    runCmd: string;
    port: number;
    readyPath: string;
    secretEnv: string[];
    notes: string[];
}

export interface CreateProjectInput {
    repo: string;
    adapterKind: AdapterKind;
    previewEnvIncludes: string;
    mentionHandle: string;
    baselineUrl: string | null;
    adapter: GenericAdapterInput | null;
    /** Present when the project has no preview env and Sentinel must start it itself. */
    runRecipe?: RunRecipeInput | null;
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
    | { kind: "autodetect"; proposal: AutodetectProposal }
    | { kind: "trial"; ok: boolean; baseUrl: string | null };

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

/** Where an executed step came from; absent (= "plan") for ordinary planned steps. */
export type StepOrigin = "plan" | "recovery" | "replan";

export interface StepResultView {
    index: number;
    step: PlanStep;
    status: StepStatus;
    /** Self-correction provenance; omitted for planned steps. */
    origin?: StepOrigin;
    /** For a recovery step: the index of the failed planned step it tried to rescue. */
    recoveredFrom?: number;
    /** What Sentinel observed (or why it failed / was blocked). */
    observation: string;
    screenshotUrl: string | null;
    consoleErrors: string[];
    networkErrors: NetworkError[];
    /** Skill-vs-live divergences noticed on this step; omitted when there were none. */
    discrepancies?: SkillDiscrepancy[];
    /** Ms from the recording's start to when this step began — positions its marker on the video timeline. */
    startMs: number | null;
    /** Ms from the recording's start to this step's screenshot (its observed end state). */
    endMs: number | null;
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
    /** Corrective recovery attempts spent (0 for runs predating self-correction). */
    recoveries: number;
    /** True when the plan's remainder was regenerated mid-run. */
    replanned: boolean;
    model: string;
    plan: TestPlan;
    results: StepResultView[];
    verdict: Verdict;
    videoUrl: string | null;
    createdAt: string;
    status: RunStatus;
}
