import type { Page } from "playwright";
import { z } from "zod";
import type { ControlRef } from "../graph/types";
import type { Reasoner } from "../reasoner/types";
import type { PlanStep, StepResult, Verdict } from "./types";

/**
 * Step-level self-correction. When a planned step fails, the executor must decide WHO
 * failed: Sentinel (wrong page, badly described control, page not settled) or the app
 * (an error state on the preview). The first kind is recoverable; the second is the
 * very evidence a QA run exists to collect and is NEVER recovered — an over-eager
 * recovery here would launder a real regression into a pass. Every helper is therefore
 * biased toward "app-error", and anything ambiguous stays a failure.
 *
 * Recovery only ever *proposes* ordinary plan steps. They execute through the same
 * `executeStep` path as planned steps, so the destructive-control block and the
 * read-only network guard stay the single enforcement points — self-correction adds no
 * new browser capability and no way around the safety boundary.
 */

export type FailureClass = "app-error" | "agent-error" | "transient" | "precondition-lost";

export interface FailureDiagnosis {
    failureClass: FailureClass;
    /** One line of triage reasoning, appended to the step observation for the report/judge. */
    reason: string;
}

/** Classes the executor may act on. "app-error" is deliberately not one of them. */
export function isRecoverable(failureClass: FailureClass): boolean {
    return failureClass !== "app-error";
}

/**
 * Non-LLM override: a step that surfaced console exceptions or failed requests is the
 * app misbehaving, full stop — classification short-circuits to "app-error" without
 * asking the model, so a broken preview can never be argued into a recovery.
 */
export function hardFailureClass(result: Pick<StepResult, "consoleErrors" | "networkErrors">): FailureClass | null {
    return result.consoleErrors.length > 0 || result.networkErrors.length > 0 ? "app-error" : null;
}

/**
 * A corrective step with the same action as the failed step IS the retry (e.g. "click,
 * but the control is actually called 'Preferences'"), so the original is not re-run. A
 * different action (e.g. "navigate back first") is a precursor — the original step gets
 * one retry after it.
 */
export function isReplacement(original: PlanStep, corrective: PlanStep): boolean {
    return original.action === corrective.action;
}

const CLASSIFY_SCHEMA = z.object({
    failureClass: z.enum(["app-error", "agent-error", "transient", "precondition-lost"]),
    reason: z.string(),
});

const CLASSIFY_SYSTEM =
    "You triage one failed browser-test step for a QA agent that is verifying a pull request on a preview " +
    "deployment. Decide who is at fault. 'app-error': the page itself looks broken (error text, blank render), or " +
    "the agent IS on the intended page and the expectation is simply not met — that is evidence about the PR, not a " +
    "mistake to fix. 'agent-error': the app looks healthy but the agent is on the wrong page, opened the wrong " +
    "menu/dialog, or the step described a control that plainly goes by another name on screen. 'transient': the page " +
    "visibly has not settled (spinner, skeleton, loading state). 'precondition-lost': the step assumed a state an " +
    "earlier failed step never produced. BIAS: when in doubt answer 'app-error' — a QA agent must never explain " +
    "away a potential regression.";

/**
 * Classify a failed step from a fresh screenshot. Falls back to "app-error" (= no
 * recovery) on any model error, so classification can only ever fail safe.
 */
export async function classifyFailure(
    reasoner: Reasoner,
    page: Page,
    step: PlanStep,
    observation: string,
): Promise<FailureDiagnosis> {
    const shot = await page.screenshot().catch(() => null);
    const prompt = `Failed step: ${step.action} "${step.target}"${step.value ? ` = "${step.value}"` : ""}
Expected after the step: ${step.expect}
What actually happened: ${observation}
Current URL path: ${new URL(page.url()).pathname}

The screenshot is the page right now. Classify the failure.`;
    return reasoner
        .generateObject({
            prompt,
            system: CLASSIFY_SYSTEM,
            schema: CLASSIFY_SCHEMA,
            images: shot ? [shot] : undefined,
            maxTokens: 300,
            telemetryLabel: "triage-failure",
        })
        .catch(
            (error): FailureDiagnosis => ({
                failureClass: "app-error",
                reason: `triage could not run (${error instanceof Error ? error.message : String(error)}) — failing safe`,
            }),
        );
}

const RECOVERY_STEP = z.object({
    action: z.enum(["navigate", "click", "type", "select", "hover", "scroll", "assert", "wait"]),
    target: z.string(),
    value: z.string().nullable(),
    expect: z.string(),
    reason: z.string(),
});

const RECOVERY_SCHEMA = z.object({ step: RECOVERY_STEP.nullable() });

const RECOVERY_SYSTEM =
    "You propose AT MOST ONE corrective browser step for a QA agent whose planned step just failed through its own " +
    "mistake (wrong page, misnamed control, lost precondition). Ground the step in the visible controls and routes " +
    "you are given. STRICT read-only rule: never propose a step that creates, saves, sends, deletes, pays, or " +
    "publishes anything. If the fix is simply that the control goes by another name, return the SAME action with the " +
    "corrected target. If the agent first needs to be somewhere else, return a single 'navigate' (target = the bare " +
    "destination path). If no single safe step would plausibly help, return null for step.";

export interface RecoveryArgs {
    step: PlanStep;
    observation: string;
    diagnosis: FailureDiagnosis;
    /** Live controls on the current page, for grounding the corrective target. */
    controls: ControlRef[];
    /** Templated path the agent is on right now. */
    currentRoute: string;
}

/** Ask the model for one grounded corrective step; null = no recovery worth attempting. */
export async function proposeRecovery(reasoner: Reasoner, args: RecoveryArgs): Promise<PlanStep | null> {
    const controlList = args.controls
        .filter((c) => c.name)
        .slice(0, 40)
        .map((c) => `${c.role}:"${c.name}"${c.href ? ` -> ${c.href}` : ""}`)
        .join("\n");
    const prompt = `Failed step: ${args.step.action} "${args.step.target}"${args.step.value ? ` = "${args.step.value}"` : ""}
Expected: ${args.step.expect}
What happened: ${args.observation}
Triage: ${args.diagnosis.failureClass} — ${args.diagnosis.reason}
Current page: ${args.currentRoute}
Controls visible right now:
${controlList || "(none extracted)"}

Propose one read-only corrective step, or null.`;
    const result = await reasoner
        .generateObject({
            prompt,
            system: RECOVERY_SYSTEM,
            schema: RECOVERY_SCHEMA,
            maxTokens: 500,
            telemetryLabel: "propose-recovery",
        })
        .catch(() => ({ step: null }));
    return result.step;
}

/**
 * One line for the verdict prompt disclosing how much self-correction the run needed;
 * empty string when none. The judge must weigh a rescued run differently from a clean one.
 */
export function selfCorrectionVerdictNote(recoveries: number, replanned: boolean): string {
    if (recoveries === 0 && !replanned) {
        return "";
    }
    const parts: string[] = [];
    if (recoveries > 0) {
        parts.push(`${recoveries} step(s) only succeeded after the agent corrected its own navigation/targeting`);
    }
    if (replanned) {
        parts.push("the remainder of the plan was regenerated mid-run after consecutive failures");
    }
    return `Self-correction occurred: ${parts.join("; ")}. Steps tagged [recovery]/[replan] were not part of the original plan — weigh the evidence accordingly.`;
}

/**
 * A run that had to replan mid-way can demonstrate the PR works, but not with full
 * certainty — the original plan's assumptions were wrong somewhere. Cap confidence at
 * "medium" so self-correction can rescue the run, never the verdict's certainty.
 */
export function capConfidenceAfterReplan(verdict: Verdict, replanned: boolean): Verdict {
    if (!replanned || verdict.confidence !== "high") {
        return verdict;
    }
    return { ...verdict, confidence: "medium" };
}
