import { z } from "zod";
import type { ControlRef } from "../graph/types";
import type { Reasoner } from "../reasoner/types";
import { PLAN_SYSTEM } from "./plan";
import type { PlanStep, StepResult } from "./types";

/**
 * The one bounded mid-run replan. When consecutive step failures say the PLAN itself is
 * wrong (wrong start route, feature behind a different flow, hallucinated control), the
 * executor abandons the remaining steps and asks for a revised remainder from where the
 * browser actually is. Revised steps run through the same `executeStep`/safety path as
 * planned ones, and the run's manifest discloses the replan — the judge caps confidence
 * accordingly (`capConfidenceAfterReplan`).
 */

const REPLAN_SCHEMA = z.object({
    steps: z
        .array(
            z.object({
                action: z.enum(["navigate", "click", "type", "select", "hover", "scroll", "assert", "wait"]),
                target: z.string(),
                value: z.string().nullable(),
                expect: z.string(),
                reason: z.string(),
            }),
        )
        .max(10),
    notes: z.array(z.string()),
});

const REPLAN_SYSTEM =
    `${PLAN_SYSTEM} ` +
    "You are REVISING the remainder of a plan MID-RUN: some steps already executed (with the outcomes shown) and the " +
    "rest were abandoned because consecutive failures suggest the original plan misread the app. Continue from the " +
    "CURRENT page — do not repeat steps that already succeeded, do not retry an approach that already failed the " +
    "same way, and prefer 3-8 steps. If the executed outcomes look like the app itself is broken, do not route " +
    "around it: assert the broken behavior so the verdict captures it.";

export interface ReplanContext {
    prTitle: string;
    prBody: string;
    /** The original plan's goal — the replan revises the route to it, not the goal itself. */
    goal: string;
    /** Templated path the browser is on right now. */
    currentRoute: string;
    /** Everything executed so far, including failed and recovery steps. */
    executed: StepResult[];
    /** The abandoned remainder of the original plan. */
    remaining: PlanStep[];
    /** Live controls on the current page, for grounding. */
    controls: ControlRef[];
    /** Distilled navigation skills — the same text the original planner saw, when a pack exists. */
    skills?: string;
}

export interface ReplanResult {
    steps: PlanStep[];
    notes: string[];
}

function executedLines(executed: StepResult[]): string {
    return executed
        .map((r) => {
            const origin = r.origin && r.origin !== "plan" ? `, ${r.origin}` : "";
            return `${r.index + 1}. [${r.status}${origin}] ${r.step.action} "${r.step.target}" — ${r.observation}`;
        })
        .join("\n");
}

/** Revised remainder of the plan, or null when the model produced nothing usable. */
export async function replanRemainder(reasoner: Reasoner, context: ReplanContext): Promise<ReplanResult | null> {
    const controlList = context.controls
        .filter((c) => c.name)
        .slice(0, 40)
        .map((c) => `${c.role}:"${c.name}"${c.href ? ` -> ${c.href}` : ""}`)
        .join(", ");
    const abandoned = context.remaining.map((s) => `- ${s.action} "${s.target}" (expect: ${s.expect})`).join("\n");
    const prompt = `PR: ${context.prTitle}

Description:
${context.prBody || "(none)"}

Test goal (unchanged): ${context.goal}

Steps executed so far:
${executedLines(context.executed) || "(none)"}

Abandoned remaining steps (do NOT repeat them verbatim — they assumed the wrong app state):
${abandoned || "(none)"}

Current page: ${context.currentRoute}
Controls visible right now: ${controlList || "(none extracted)"}
${context.skills ? `\nNavigation guide (distilled skills):\n${context.skills}\n` : ""}
Plan the revised REMAINDER of the read-only test from the current page.`;
    const result = await reasoner
        .generateObject({
            prompt,
            system: REPLAN_SYSTEM,
            schema: REPLAN_SCHEMA,
            maxTokens: 2000,
            telemetryLabel: "replan",
        })
        .catch((): ReplanResult | null => null);
    if (!result || result.steps.length === 0) {
        return null;
    }
    return result;
}
