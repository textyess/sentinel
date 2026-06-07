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

export interface StepResult {
    index: number;
    step: PlanStep;
    status: "ok" | "failed" | "blocked" | "skipped";
    /** What Sentinel observed (or why it failed / was blocked). */
    observation: string;
    screenshot: string | null;
    consoleErrors: string[];
    networkErrors: { url: string; status: number }[];
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
    /** True when the run never wrote (read-only enforced). */
    readOnly: boolean;
    blockedWrites: number;
    model: string;
    plan: TestPlan;
    results: StepResult[];
    verdict: Verdict;
    video: string | null;
    createdAt: string;
}
