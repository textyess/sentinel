import * as fs from "node:fs";
import * as path from "node:path";
import type { Page } from "playwright";
import { z } from "zod";
import type { DriverSession } from "../browser/driver";
import { clickBySelectors, fillBySelectors } from "../browser/interact";
import { dismissOverlays, extractControls, waitForInteractive } from "../graph/extract";
import type { ControlRef } from "../graph/types";
import { isLoginPath, pathnameOf, stripQuery } from "../graph/url";
import { humanDwell, type PacingOptions, thinkPause } from "../human/pacing";
import { logger } from "../logger";
import type { Reasoner } from "../reasoner/types";
import type { PlanStep, StepResult, TestPlan, Verdict } from "./types";

export interface ExecuteOptions {
    reasoner: Reasoner;
    destructive: RegExp[];
    settleMs: number;
    navTimeoutMs: number;
    clickTimeoutMs: number;
    screenshotDir: string;
    pacing: PacingOptions;
    loginPath: string;
}

const RESOLVE_SCHEMA = z.object({ index: z.number().int(), confidence: z.enum(["high", "medium", "low"]) });
const ASSERT_SCHEMA = z.object({ pass: z.boolean(), observation: z.string() });
const VERDICT_SCHEMA = z.object({
    outcome: z.enum(["pass", "fail", "uncertain"]),
    confidence: z.enum(["high", "medium", "low"]),
    summary: z.string(),
    evidence: z.array(z.string()),
});

/** Ask the model which of the live controls best matches a step's target description. */
async function resolveControl(reasoner: Reasoner, controls: ControlRef[], target: string): Promise<number> {
    if (controls.length === 0) {
        return -1;
    }
    const list = controls.map((c, i) => `${i}. ${c.role}:"${c.name}"${c.href ? ` -> ${c.href}` : ""}`).join("\n");
    const result = await reasoner
        .generateObject({
            prompt: `Target control: "${target}"\n\nThe page's actual controls:\n${list}\n\nReturn the index of the control that best matches the target, or -1 if none matches.`,
            system: "You match a described UI control to one of the page's real controls. Return only the index.",
            schema: RESOLVE_SCHEMA,
            maxTokens: 200,
            telemetryLabel: "resolve-control",
        })
        .catch(() => ({ index: -1, confidence: "low" as const }));
    return result.index >= 0 && result.index < controls.length ? result.index : -1;
}

/** Verify a step's expectation against a screenshot of the current page (vision). */
async function assertExpectation(
    reasoner: Reasoner,
    page: Page,
    expectation: string,
    controls: ControlRef[],
): Promise<{ pass: boolean; observation: string }> {
    const shot = await page.screenshot().catch(() => null);
    const controlList = controls
        .slice(0, 40)
        .map((c) => `${c.role}:"${c.name}"`)
        .join(", ");
    return reasoner
        .generateObject({
            prompt: `Expectation: "${expectation}"\n\nThe screenshot is the current page. Visible controls: ${controlList}\n\nDoes the page satisfy the expectation? Reply pass=true/false with a one-sentence observation of what you actually see.`,
            system: "You verify a UI expectation against a screenshot. Be strict but fair — judge only what is visible.",
            schema: ASSERT_SCHEMA,
            images: shot ? [shot] : undefined,
            maxTokens: 400,
            telemetryLabel: "assert",
        })
        .catch((error) => ({
            pass: false,
            observation: `assert could not run: ${error instanceof Error ? error.message : String(error)}`,
        }));
}

async function hoverFirst(page: Page, selectors: string[], timeoutMs: number): Promise<boolean> {
    for (const selector of selectors) {
        try {
            const locator = page.locator(selector);
            if ((await locator.count()) !== 1) {
                continue;
            }
            await locator.hover({ timeout: timeoutMs });
            return true;
        } catch {
            // try next selector
        }
    }
    return false;
}

async function executeStep(
    session: DriverSession,
    step: PlanStep,
    index: number,
    options: ExecuteOptions,
): Promise<StepResult> {
    const { page } = session;
    const consoleBefore = session.consoleErrors.length;
    const networkBefore = session.network.length;
    let status: StepResult["status"] = "ok";
    let observation = "";

    await thinkPause(page, options.pacing);
    try {
        if (step.action === "navigate") {
            const target = step.target.replace(/^https?:\/\/[^/]+/, "");
            const path2 = target.startsWith("/") ? target : `/${target}`;
            await page.goto(path2, { waitUntil: "domcontentloaded", timeout: options.navTimeoutMs });
            await waitForInteractive(page, options.settleMs);
            await dismissOverlays(page);
            await humanDwell(page, options.pacing);
            if (isLoginPath(page.url(), options.loginPath)) {
                status = "failed";
                observation = "redirected to login";
            } else {
                observation = `at ${pathnameOf(page.url())}`;
            }
        } else if (step.action === "click" || step.action === "hover") {
            const controls = await extractControls(page, options.destructive, session.baseUrl).catch(
                (): ControlRef[] => [],
            );
            const idx = await resolveControl(options.reasoner, controls, step.target);
            const control = idx >= 0 ? controls[idx] : undefined;
            if (!control) {
                status = "failed";
                observation = `control not found: "${step.target}"`;
            } else if (control.destructive) {
                status = "blocked";
                observation = `"${control.name}" looks like a write/destructive action — not clicked (read-only)`;
            } else {
                const did =
                    step.action === "click"
                        ? await clickBySelectors(page, control.selectors, options.clickTimeoutMs)
                        : await hoverFirst(page, control.selectors, options.clickTimeoutMs);
                await waitForInteractive(page, options.settleMs);
                await dismissOverlays(page);
                status = did ? "ok" : "failed";
                observation = did ? `${step.action}ed "${control.name}"` : `couldn't ${step.action} "${control.name}"`;
            }
        } else if (step.action === "type" || step.action === "select") {
            const inputs = (
                await extractControls(page, options.destructive, session.baseUrl).catch((): ControlRef[] => [])
            ).filter((c) => c.kind === "input");
            const idx = await resolveControl(options.reasoner, inputs, step.target);
            const control = idx >= 0 ? inputs[idx] : undefined;
            if (!control) {
                status = "failed";
                observation = `input not found: "${step.target}"`;
            } else {
                const did = await fillBySelectors(page, control.selectors, step.value ?? "", options.clickTimeoutMs);
                status = did ? "ok" : "failed";
                observation = did ? `typed into "${control.name}"` : `couldn't type into "${control.name}"`;
            }
        } else if (step.action === "scroll") {
            await page.mouse.wheel(0, 600).catch(() => {});
            await humanDwell(page, options.pacing);
            observation = "scrolled";
        } else if (step.action === "wait") {
            await waitForInteractive(page, options.settleMs);
            observation = "waited for the page to settle";
        } else {
            const controls = await extractControls(page, options.destructive, session.baseUrl).catch(
                (): ControlRef[] => [],
            );
            const judged = await assertExpectation(options.reasoner, page, step.expect, controls);
            status = judged.pass ? "ok" : "failed";
            observation = judged.observation;
        }
    } catch (error) {
        status = "failed";
        observation = error instanceof Error ? error.message : String(error);
    }

    let screenshot: string | null = null;
    const file = `step-${String(index + 1).padStart(2, "0")}.png`;
    try {
        fs.mkdirSync(options.screenshotDir, { recursive: true });
        await page.screenshot({ path: path.join(options.screenshotDir, file) });
        screenshot = path.join("screenshots", file);
    } catch {
        // A screenshot failure must not abort the run.
    }

    const networkErrors = session.network
        .slice(networkBefore)
        .filter((e) => e.status >= 400 && e.status !== 423)
        .map((e) => ({ url: stripQuery(e.url), status: e.status }));
    const consoleErrors = session.consoleErrors.slice(consoleBefore);

    return { index, step, status, observation, screenshot, consoleErrors, networkErrors };
}

export async function executePlan(
    session: DriverSession,
    plan: TestPlan,
    options: ExecuteOptions,
): Promise<StepResult[]> {
    const results: StepResult[] = [];
    for (let i = 0; i < plan.steps.length; i++) {
        const step = plan.steps[i];
        if (!step) {
            continue;
        }
        const result = await executeStep(session, step, i, options);
        results.push(result);
        logger.info(`step ${i + 1}/${plan.steps.length}  [${result.status}]  ${step.action} "${step.target}"`);
    }
    return results;
}

/** Judge whether the PR does what it claims, from the executed steps. Read-only 'blocked' steps are not failures. */
export async function judgeVerdict(
    reasoner: Reasoner,
    prTitle: string,
    prBody: string,
    plan: TestPlan,
    results: StepResult[],
): Promise<Verdict> {
    const stepLines = results
        .map((r) => `${r.index + 1}. [${r.status}] ${r.step.action} "${r.step.target}" — ${r.observation}`)
        .join("\n");
    return reasoner
        .generateObject({
            prompt: `PR: ${prTitle}\n${prBody}\n\nTest goal: ${plan.goal}\n\nExecuted steps:\n${stepLines}\n\nDid the PR's change work as claimed, based ONLY on what the steps observed? A 'blocked' step is an intentional read-only stop (e.g. a write boundary), NOT a failure. Give outcome pass/fail/uncertain, confidence, a short calm evidence-first summary, and 2-4 evidence bullets.`,
            system: "You are Sentinel, a precise QA agent. Judge whether a PR does what it claims from the executed test steps. Prefer 'uncertain' over guessing; never claim a pass you can't support.",
            schema: VERDICT_SCHEMA,
            maxTokens: 600,
            telemetryLabel: "judge",
        })
        .catch(() => ({
            outcome: "uncertain" as const,
            confidence: "low" as const,
            summary: "Verdict generation failed.",
            evidence: [],
        }));
}
