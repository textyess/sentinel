import * as fs from "node:fs";
import * as path from "node:path";
import type { Page } from "playwright";
import { z } from "zod";
import type { DriverSession } from "../browser/driver";
import { clickBySelectorsTracked, fillBySelectorsTracked, moveCursorToLocator } from "../browser/interact";
import { dismissOverlays, extractControls, waitForInteractive } from "../graph/extract";
import type { ControlRef, InteractionGraph } from "../graph/types";
import { isLoginPath, normalizePath, stripQuery } from "../graph/url";
import { humanDwell, type PacingOptions, thinkPause } from "../human/pacing";
import { logger } from "../logger";
import type { Reasoner } from "../reasoner/types";
import type { PageSkill, PageSkillIndex } from "../skills/load";
import { destinationDrift, isSuccessfulClick, missingControl, selectorStale } from "./discrepancy";
import { navigateLikeUser, routesOpenedBy, toTargetPath } from "./navigate";
import { discrepancyVerdictNote } from "./proposals";
import {
    capConfidenceAfterReplan,
    classifyFailure,
    hardFailureClass,
    isRecoverable,
    isReplacement,
    proposeRecovery,
    selfCorrectionVerdictNote,
} from "./recover";
import { replanRemainder } from "./replan";
import type { PlanStep, SkillDiscrepancy, StepOrigin, StepResult, TestPlan, Verdict } from "./types";

/**
 * Self-correction policy for a run. Recovery/replan steps only ever execute through the
 * same `executeStep` path as planned steps (destructive block + read-only guard intact),
 * failures classified as the APP misbehaving are never recovered, and everything is
 * disclosed in the results/manifest — see `recover.ts` for the full rationale.
 */
export interface SelfCorrectOptions {
    /** Max corrective recovery attempts across the whole run. */
    maxRecoveries: number;
    /** Max mid-run replans of the remaining steps (typically 1). */
    maxReplans: number;
    /** PR context for the replanner — the executor otherwise never sees the PR. */
    prTitle: string;
    prBody: string;
    /** Distilled navigation skills text the original planner saw; null when no pack exists. */
    skillsText: string | null;
}

export interface ExecuteOptions {
    reasoner: Reasoner;
    destructive: RegExp[];
    settleMs: number;
    navTimeoutMs: number;
    clickTimeoutMs: number;
    screenshotDir: string;
    pacing: PacingOptions;
    loginPath: string;
    /** The baseline interaction graph — the map a 'navigate' step clicks through, like a user. */
    graph: InteractionGraph;
    /** Per-route baseline page skills for selector-first execution; null = live selectors only. */
    pageSkills: PageSkillIndex | null;
    /** Self-correction policy; null = execute the plan verbatim (no recovery, no replan). */
    selfCorrect: SelfCorrectOptions | null;
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
            await moveCursorToLocator(page, locator, timeoutMs);
            await locator.hover({ timeout: timeoutMs });
            return true;
        } catch {
            // try next selector
        }
    }
    return false;
}

/**
 * Ranked, self-healing selectors for acting on a live control: the baseline skill's
 * exact selectors first (a crawl verified them, so they're the most stable), then the
 * live page's own selectors as fallback — `clickBySelectors` / `fillBySelectors` walk the
 * list until one resolves. The skill control is matched to the live one by role+name+href;
 * a null index or no match yields just the live selectors, so this is purely additive and
 * never bypasses safety (the live control has already cleared the destructive guard).
 */
export function candidateSelectors(live: ControlRef, pageSkill: PageSkill | null): string[] {
    const match = pageSkill?.controls.find(
        (control) => control.role === live.role && control.name === live.name && control.href === live.href,
    );
    const seen = new Set<string>();
    const ranked: string[] = [];
    for (const selector of match ? [...match.selectors, ...live.selectors] : live.selectors) {
        if (!seen.has(selector)) {
            seen.add(selector);
            ranked.push(selector);
        }
    }
    return ranked;
}

/** The templated route the page is on right now — the key into the page-skill index. */
function liveRouteKey(page: Page, baseUrl: string): string {
    return normalizePath(page.url(), baseUrl).path;
}

interface StepProvenance {
    origin: StepOrigin;
    /** For recovery steps: index of the failed planned step being rescued. */
    recoveredFrom: number | null;
}

async function executeStep(
    session: DriverSession,
    step: PlanStep,
    index: number,
    options: ExecuteOptions,
    provenance: StepProvenance,
): Promise<StepResult> {
    const { page } = session;
    const consoleBefore = session.consoleErrors.length;
    const networkBefore = session.network.length;
    let status: StepResult["status"] = "ok";
    let observation = "";
    const discrepancies: SkillDiscrepancy[] = [];

    // Stamp the step's position on the recording timeline before any work (including the
    // think-pause), so the report's marker sits where the step visibly begins.
    const startMs = Date.now() - session.videoStartedAt;

    await thinkPause(page, options.pacing);
    try {
        if (step.action === "navigate") {
            // The planner is asked for a bare path but sometimes appends a hint
            // ("/agents (via 'Agents button in sidebar')"); loaded verbatim that 404s.
            const targetPath = toTargetPath(step.target);
            // Move between pages the way a user does — click the app's own menu/nav,
            // not the URL bar. Falls back to a direct load only when no in-app route exists.
            const outcome = await navigateLikeUser(page, targetPath, options.graph, {
                destructive: options.destructive,
                baseUrl: session.baseUrl,
                loginPath: options.loginPath,
                settleMs: options.settleMs,
                navTimeoutMs: options.navTimeoutMs,
                clickTimeoutMs: options.clickTimeoutMs,
            });
            await dismissOverlays(page);
            await humanDwell(page, options.pacing);
            status = outcome.ok ? "ok" : "failed";
            observation = outcome.observation;
            // Did clicking the app's own nav land where the skill said it would? Only a
            // SUCCESSFUL in-app click counts — a failed nav or a login bounce is not drift.
            const expected = normalizePath(targetPath, session.baseUrl).path;
            const navDrift = destinationDrift(
                options.pageSkills?.get(expected) ?? null,
                expected,
                outcome.landed,
                isSuccessfulClick(outcome.method, outcome.ok),
            );
            if (navDrift) {
                discrepancies.push(navDrift);
            }
        } else if (step.action === "click" || step.action === "hover") {
            const routeKey = liveRouteKey(page, session.baseUrl);
            const pageSkill = options.pageSkills?.get(routeKey) ?? null;
            const controls = await extractControls(page, options.destructive, session.baseUrl).catch(
                (): ControlRef[] => [],
            );
            const idx = await resolveControl(options.reasoner, controls, step.target);
            const control = idx >= 0 ? controls[idx] : undefined;
            if (!control) {
                status = "failed";
                observation = `control not found: "${step.target}"`;
                const miss = missingControl(routeKey, pageSkill, step.target);
                if (miss) {
                    discrepancies.push(miss);
                }
            } else if (control.destructive) {
                status = "blocked";
                observation = `"${control.name}" looks like a write/destructive action — not clicked (read-only)`;
            } else if (step.action === "click") {
                const selectors = candidateSelectors(control, pageSkill);
                const used = await clickBySelectorsTracked(page, selectors, options.clickTimeoutMs);
                await waitForInteractive(page, options.settleMs);
                await dismissOverlays(page);
                const did = used !== null;
                status = did ? "ok" : "failed";
                observation = did ? `clicked "${control.name}"` : `couldn't click "${control.name}"`;
                if (did) {
                    const stale = selectorStale(routeKey, pageSkill, control, used);
                    if (stale) {
                        discrepancies.push(stale);
                    }
                    // A click that changed route is a navigation: did it land where the link
                    // pointed? Skip a bounce to login — that's an auth failure, not skill drift.
                    const after = liveRouteKey(page, session.baseUrl);
                    if (control.href !== null && after !== routeKey && !isLoginPath(page.url(), options.loginPath)) {
                        const expected = normalizePath(control.href, session.baseUrl).path;
                        const clickDrift = destinationDrift(
                            options.pageSkills?.get(expected) ?? null,
                            expected,
                            after,
                            true,
                        );
                        if (clickDrift) {
                            discrepancies.push(clickDrift);
                        }
                    }
                } else if (!control.href) {
                    // The click missed and the control has no href of its own — likely a
                    // sidebar group toggle that only opens a submenu. If the map shows it
                    // opens onto a route, finish like a user: navigate there (which expands
                    // the menu and follows the revealed link).
                    const dest = routesOpenedBy(options.graph, control.role, control.name)[0];
                    if (dest) {
                        const outcome = await navigateLikeUser(page, dest, options.graph, {
                            destructive: options.destructive,
                            baseUrl: session.baseUrl,
                            loginPath: options.loginPath,
                            settleMs: options.settleMs,
                            navTimeoutMs: options.navTimeoutMs,
                            clickTimeoutMs: options.clickTimeoutMs,
                        });
                        await dismissOverlays(page);
                        status = outcome.ok ? "ok" : "failed";
                        observation = `"${control.name}" only opens a submenu — ${outcome.observation}`;
                    }
                }
            } else {
                const selectors = candidateSelectors(control, pageSkill);
                const did = await hoverFirst(page, selectors, options.clickTimeoutMs);
                await waitForInteractive(page, options.settleMs);
                await dismissOverlays(page);
                status = did ? "ok" : "failed";
                observation = did ? `hovered "${control.name}"` : `couldn't hover "${control.name}"`;
            }
        } else if (step.action === "type" || step.action === "select") {
            const routeKey = liveRouteKey(page, session.baseUrl);
            const pageSkill = options.pageSkills?.get(routeKey) ?? null;
            const inputs = (
                await extractControls(page, options.destructive, session.baseUrl).catch((): ControlRef[] => [])
            ).filter((c) => c.kind === "input");
            const idx = await resolveControl(options.reasoner, inputs, step.target);
            const control = idx >= 0 ? inputs[idx] : undefined;
            if (!control) {
                status = "failed";
                observation = `input not found: "${step.target}"`;
                const miss = missingControl(routeKey, pageSkill, step.target);
                if (miss) {
                    discrepancies.push(miss);
                }
            } else {
                const selectors = candidateSelectors(control, pageSkill);
                const used = await fillBySelectorsTracked(page, selectors, step.value ?? "", options.clickTimeoutMs);
                const did = used !== null;
                status = did ? "ok" : "failed";
                observation = did ? `typed into "${control.name}"` : `couldn't type into "${control.name}"`;
                if (did) {
                    const stale = selectorStale(routeKey, pageSkill, control, used);
                    if (stale) {
                        discrepancies.push(stale);
                    }
                }
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
    // The screenshot is the observed end state, so the timeline window for this step closes here.
    const endMs = Date.now() - session.videoStartedAt;

    const networkErrors = session.network
        .slice(networkBefore)
        .filter((e) => e.status >= 400 && e.status !== 423)
        .map((e) => ({ url: stripQuery(e.url), status: e.status }));
    const consoleErrors = session.consoleErrors.slice(consoleBefore);

    if (discrepancies.length > 0) {
        observation = `${observation} [skill drift: ${discrepancies.map((d) => d.kind).join(", ")}]`;
    }

    return {
        index,
        step,
        status,
        observation,
        screenshot,
        consoleErrors,
        networkErrors,
        startMs,
        endMs,
        ...(discrepancies.length > 0 ? { discrepancies } : {}),
        ...(provenance.origin !== "plan" ? { origin: provenance.origin } : {}),
        ...(provenance.recoveredFrom !== null ? { recoveredFrom: provenance.recoveredFrom } : {}),
    };
}

export interface ExecuteOutcome {
    results: StepResult[];
    /** Corrective recovery attempts actually spent (each ran 1-2 extra steps). */
    recoveries: number;
    /** True when the remaining steps were regenerated mid-run. */
    replanned: boolean;
}

/** Consecutive planned-step failures that trigger the (bounded) mid-run replan. */
const REPLAN_AFTER_CONSECUTIVE_FAILURES = 2;

/** A result for an abandoned planned step — never executed, recorded for an honest timeline. */
function skippedResult(step: PlanStep, index: number, videoStartedAt: number): StepResult {
    const nowMs = Date.now() - videoStartedAt;
    return {
        index,
        step,
        status: "skipped",
        observation: "skipped — superseded by the mid-run replan",
        screenshot: null,
        consoleErrors: [],
        networkErrors: [],
        startMs: nowMs,
        endMs: nowMs,
    };
}

/**
 * Tier-A recovery for one failed step: triage the failure, and only when it was
 * Sentinel's own mistake (never the app's), execute one grounded corrective step — plus
 * one retry of the original when the corrective was a precursor (e.g. a navigate) rather
 * than a replacement. Returns the extra results it ran and whether the failure was
 * rescued. The failed result's observation gains a `[triage: …]` tag either way, so the
 * judge sees why a failure was or wasn't recovered.
 */
async function recoverStep(
    session: DriverSession,
    failed: StepResult,
    options: ExecuteOptions,
    nextIndex: () => number,
): Promise<{ extra: StepResult[]; rescued: boolean }> {
    const { page } = session;
    const hard = hardFailureClass(failed);
    const diagnosis = hard
        ? { failureClass: hard, reason: "the step surfaced console/network errors — treated as app behavior" }
        : await classifyFailure(options.reasoner, page, failed.step, failed.observation);
    failed.observation = `${failed.observation} [triage: ${diagnosis.failureClass}]`;
    if (!isRecoverable(diagnosis.failureClass)) {
        return { extra: [], rescued: false };
    }
    const controls = await extractControls(page, options.destructive, session.baseUrl).catch((): ControlRef[] => []);
    const corrective = await proposeRecovery(options.reasoner, {
        step: failed.step,
        observation: failed.observation,
        diagnosis,
        controls,
        currentRoute: liveRouteKey(page, session.baseUrl),
    });
    if (!corrective) {
        return { extra: [], rescued: false };
    }
    const provenance: StepProvenance = { origin: "recovery", recoveredFrom: failed.index };
    const extra: StepResult[] = [];
    let last = await executeStep(session, corrective, nextIndex(), options, provenance);
    extra.push(last);
    if (last.status === "ok" && !isReplacement(failed.step, corrective)) {
        last = await executeStep(session, failed.step, nextIndex(), options, provenance);
        extra.push(last);
    }
    return { extra, rescued: last.status === "ok" };
}

/**
 * Execute the plan with bounded self-correction. A failed step may earn one recovery
 * attempt (when triage says the failure was Sentinel's, not the app's), and repeated
 * consecutive failures may trigger one replan of the remaining steps from wherever the
 * browser actually is. Both are budgeted, fully disclosed in the results, and run every
 * extra step through the same safety path as planned steps. With `selfCorrect: null`
 * this degrades to the plain linear run.
 */
export async function executePlan(
    session: DriverSession,
    plan: TestPlan,
    options: ExecuteOptions,
): Promise<ExecuteOutcome> {
    const results: StepResult[] = [];
    let steps = [...plan.steps];
    let origin: StepOrigin = "plan";
    let recoveries = 0;
    let replans = 0;
    let consecutiveFailures = 0;
    let index = 0;
    const nextIndex = (): number => index++;

    for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        if (!step) {
            continue;
        }
        const result = await executeStep(session, step, nextIndex(), options, { origin, recoveredFrom: null });
        results.push(result);
        logger.info(`step ${i + 1}/${steps.length}  [${result.status}]  ${step.action} "${step.target}"`);

        // 'blocked' is an intentional read-only stop and 'ok' speaks for itself — only a
        // genuine failure feeds the self-correction machinery.
        if (result.status !== "failed") {
            consecutiveFailures = 0;
            continue;
        }
        consecutiveFailures++;
        const sc = options.selfCorrect;
        if (!sc) {
            continue;
        }

        if (recoveries < sc.maxRecoveries) {
            const { extra, rescued } = await recoverStep(session, result, options, nextIndex);
            if (extra.length > 0) {
                recoveries++;
                results.push(...extra);
                for (const r of extra) {
                    logger.info(`step ${r.index + 1} (recovery)  [${r.status}]  ${r.step.action} "${r.step.target}"`);
                }
            }
            if (rescued) {
                consecutiveFailures = 0;
                continue;
            }
        }

        // Consecutive unrecovered failures mean the PLAN misread the app — revise the
        // remainder once, from wherever the browser actually is. The attempt is spent
        // even when the replanner returns nothing, so a collapsing run can't loop here.
        if (consecutiveFailures >= REPLAN_AFTER_CONSECUTIVE_FAILURES && replans < sc.maxReplans) {
            replans++;
            const controls = await extractControls(session.page, options.destructive, session.baseUrl).catch(
                (): ControlRef[] => [],
            );
            const revised = await replanRemainder(options.reasoner, {
                prTitle: sc.prTitle,
                prBody: sc.prBody,
                goal: plan.goal,
                currentRoute: liveRouteKey(session.page, session.baseUrl),
                executed: results,
                remaining: steps.slice(i + 1),
                controls,
                skills: sc.skillsText ?? undefined,
            });
            if (revised) {
                for (const abandoned of steps.slice(i + 1)) {
                    results.push(skippedResult(abandoned, nextIndex(), session.videoStartedAt));
                }
                steps = [...steps.slice(0, i + 1), ...revised.steps];
                origin = "replan";
                consecutiveFailures = 0;
                logger.warn(`Replanned the remainder: ${revised.steps.length} revised step(s) from the current page.`);
                for (const note of revised.notes) {
                    logger.warn(`  note: ${note}`);
                }
            }
        }
    }
    return { results, recoveries, replanned: replans > 0 };
}

/**
 * Judge whether the PR does what it claims, from the executed steps. Read-only 'blocked'
 * steps are not failures. Self-correction is disclosed to the judge (recovery/replan
 * tags, a summary note) and a replanned run can never return 'high' confidence —
 * recovery may rescue the run, never the verdict's certainty.
 */
export async function judgeVerdict(
    reasoner: Reasoner,
    prTitle: string,
    prBody: string,
    plan: TestPlan,
    results: StepResult[],
    correction: { recoveries: number; replanned: boolean } = { recoveries: 0, replanned: false },
): Promise<Verdict> {
    const stepLines = results
        .map((r) => {
            const origin = r.origin && r.origin !== "plan" ? `, ${r.origin}` : "";
            return `${r.index + 1}. [${r.status}${origin}] ${r.step.action} "${r.step.target}" — ${r.observation}`;
        })
        .join("\n");
    const driftNote = discrepancyVerdictNote(results.flatMap((r) => r.discrepancies ?? []));
    const driftBlock = driftNote ? `\n\n${driftNote}` : "";
    const correctionNote = selfCorrectionVerdictNote(correction.recoveries, correction.replanned);
    const correctionBlock = correctionNote ? `\n\n${correctionNote}` : "";
    const verdict = await reasoner
        .generateObject({
            prompt: `PR: ${prTitle}\n${prBody}\n\nTest goal: ${plan.goal}\n\nExecuted steps:\n${stepLines}${driftBlock}${correctionBlock}\n\nDid the PR's change work as claimed, based ONLY on what the steps observed? A 'blocked' step is an intentional read-only stop (e.g. a write boundary), NOT a failure. A step whose triage said 'app-error' is evidence of breakage even when later steps moved past it — it must appear in your evidence. Give outcome pass/fail/uncertain, confidence, a short calm evidence-first summary, and 2-4 evidence bullets.`,
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
    return capConfidenceAfterReplan(verdict, correction.replanned);
}
