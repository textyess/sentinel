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

/**
 * A skill-vs-live divergence noticed during execution. Detection-only — recorded as
 * inert signal that feeds the verdict and (Phase D) a `skill-proposals.json`; a verify
 * run never writes to `skills/`. Only ever produced from a real user action.
 */
export type DiscrepancyKind = "selector-stale" | "missing-control" | "destination-drift";

export interface SkillDiscrepancy {
    kind: DiscrepancyKind;
    /** Templated route the divergence was observed on (or the expected destination). */
    route: string;
    /** Owning skill slug, for provenance back to the pack. */
    skillSlug: string;
    /** One line: what the baseline skill expected vs what the live preview showed. */
    detail: string;
}

/**
 * Where an executed step came from: the original plan, a self-correction (a corrective
 * step or the retry it enabled), or the replanned remainder after a mid-run replan.
 * Absent on manifests recorded before self-correction existed — read as "plan".
 */
export type StepOrigin = "plan" | "recovery" | "replan";

export interface StepResult {
    index: number;
    step: PlanStep;
    status: "ok" | "failed" | "blocked" | "skipped";
    /** Origin of the step; omitted (= "plan") for ordinary planned steps. */
    origin?: StepOrigin;
    /** For a recovery step: the index of the failed planned step it tried to rescue. */
    recoveredFrom?: number;
    /** What Sentinel observed (or why it failed / was blocked). */
    observation: string;
    screenshot: string | null;
    consoleErrors: string[];
    networkErrors: { url: string; status: number }[];
    /** Skill-vs-live divergences noticed on this step; omitted when there were none. */
    discrepancies?: SkillDiscrepancy[];
    /** Ms from the recording's start to when this step began — places the step's marker on the video timeline. */
    startMs: number;
    /** Ms from the recording's start to when this step's screenshot was taken (the observed end state). */
    endMs: number;
}

export interface Verdict {
    outcome: "pass" | "fail" | "uncertain";
    confidence: "high" | "medium" | "low";
    summary: string;
    evidence: string[];
}

export interface VerifyManifest {
    pr: number;
    title: string;
    body: string;
    headSha: string;
    headRef: string;
    targetUrl: string;
    changedFiles: string[];
    affectedRoutes: string[];
    /** Navigation skills (slugs) that informed the plan; empty when no skill pack existed. */
    skillsUsed: string[];
    /** Page skills (slugs) whose exact baseline selectors were available to the executor. */
    pageSkillsUsed: string[];
    /** True when the run never wrote (read-only enforced). */
    readOnly: boolean;
    blockedWrites: number;
    /** Corrective recovery attempts spent during execution (0 = no self-correction needed). */
    recoveries: number;
    /** True when the remainder of the plan was regenerated mid-run after consecutive failures. */
    replanned: boolean;
    model: string;
    plan: TestPlan;
    results: StepResult[];
    verdict: Verdict;
    video: string | null;
    createdAt: string;
}
