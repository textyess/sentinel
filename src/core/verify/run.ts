import * as fs from "node:fs";
import * as path from "node:path";
import { performLogin } from "../auth/login";
import { ensureAppReachable } from "../bringup/app";
import { createSession } from "../browser/driver";
import type { EnvConfig } from "../config";
import { waitForInteractive } from "../graph/extract";
import { loadGraph } from "../graph/store";
import type { InteractionGraph } from "../graph/types";
import type { PacingOptions } from "../human/pacing";
import { logger } from "../logger";
import { getChangedFiles, getPrDiff, getPrMeta, type PrMeta } from "../pr/github";
import type { Reasoner } from "../reasoner/types";
import { runProductionPreflight } from "../safety/production-guard";
import { redactSecret } from "../safety/redact";
import { loadPageSkillIndex, loadSkillsForRoutes } from "../skills/load";
import type { BlockedRequest, RepoAdapter } from "../types";
import { executePlan, judgeVerdict } from "./execute";
import { navigateLikeUser, toTargetPath } from "./navigate";
import { generatePlan } from "./plan";
import { buildSkillProposals } from "./proposals";
import type { StepResult, TestPlan, Verdict, VerifyManifest } from "./types";

/** Filesystem-safe timestamp for run directories. */
function stamp(): string {
    return new Date().toISOString().replace(/[:.]/g, "-");
}

function pacingFromEnv(env: EnvConfig): PacingOptions {
    return { enabled: env.humanPacing, baseThinkMs: env.paceMs, maxDwellMs: env.maxDwellMs };
}

/** Close a session, logging (not rethrowing) any teardown error. Returns the video path if any. */
async function closeQuietly(close: () => Promise<{ videoPath: string | null }>): Promise<string | null> {
    try {
        const { videoPath } = await close();
        return videoPath;
    } catch (error) {
        logger.warn(`teardown: ${error instanceof Error ? error.message : String(error)}`);
        return null;
    }
}

function logPlan(plan: TestPlan): void {
    logger.success(`Plan: ${plan.goal}`);
    logger.info(`Start: ${plan.startRoute}`);
    plan.steps.forEach((step, i) => {
        const value = step.value ? ` = "${step.value}"` : "";
        logger.info(`  ${i + 1}. ${step.action} "${step.target}"${value}  → expect: ${step.expect}`);
    });
    for (const note of plan.notes) {
        logger.warn(`  note: ${note}`);
    }
}

function logVerdict(manifest: VerifyManifest): void {
    const ok = manifest.results.filter((r) => r.status === "ok").length;
    const failed = manifest.results.filter((r) => r.status === "failed").length;
    const blocked = manifest.results.filter((r) => r.status === "blocked").length;
    logger.info(`Steps: ${ok} ok, ${failed} failed, ${blocked} blocked (read-only).`);
    if (manifest.recoveries > 0 || manifest.replanned) {
        logger.warn(
            `Self-correction: ${manifest.recoveries} recovery attempt(s)${manifest.replanned ? ", remainder replanned mid-run" : ""}.`,
        );
    }
    const v = manifest.verdict;
    const line = `VERDICT: ${v.outcome.toUpperCase()} (${v.confidence}) — ${v.summary}`;
    if (v.outcome === "pass") {
        logger.success(line);
    } else if (v.outcome === "fail") {
        logger.error(line);
    } else {
        logger.warn(line);
    }
    for (const e of v.evidence) {
        logger.info(`  • ${e}`);
    }
}

export interface PlanArgs {
    /** Adapter (already scoped to the target URL for a full run). */
    adapter: RepoAdapter;
    /** "owner/name" threaded into every gh call; null lets the CLI auto-detect via cwd. */
    repo: string | null;
    prNumber: number;
    reasoner: Reasoner;
    env: EnvConfig;
    outputDir: string;
    /** When set, the run directory to use (so the caller's runId and the dir agree). */
    runDir?: string;
}

export interface PlanResult {
    meta: PrMeta;
    changedFiles: string[];
    routes: string[];
    graph: InteractionGraph;
    plan: TestPlan;
    runDir: string;
    /** Navigation skills (slugs) that informed the plan; empty when no skill pack exists. */
    skillsUsed: string[];
    /** The injected skills text the planner saw — reused verbatim by a mid-run replan. */
    skillsText: string | null;
}

/**
 * Resolve the PR, map it to routes against the baseline graph, and have the LLM
 * plan a read-only browser test. Creates the run directory and writes plan.json.
 * Throws if the project has no baseline graph yet.
 */
export async function planForProject(args: PlanArgs): Promise<PlanResult> {
    const { adapter, repo, prNumber, reasoner, outputDir } = args;
    const repoArg = repo ?? undefined;

    const meta = await getPrMeta(prNumber, repoArg);
    logger.info(`PR #${meta.number}: ${meta.title}`);
    const changedFiles = await getChangedFiles(prNumber, repoArg);
    const { routes } = adapter.affectedRoutes(changedFiles);
    logger.info(`Affected routes: ${routes.join(", ") || "(none — start at /home)"}`);

    const graphFile = path.join(outputDir, adapter.id, "graph", "latest.json");
    if (!fs.existsSync(graphFile)) {
        throw new Error(`No interaction graph at ${graphFile}. Build a baseline crawl for this project first.`);
    }
    const graph = loadGraph(graphFile);

    // Pull in the distilled navigation skills for the affected area(s) — an optional
    // enrichment on top of the raw graph map. Absent until `sentinel skills` has run.
    const skills = loadSkillsForRoutes(outputDir, adapter.id, routes);
    if (skills) {
        logger.info(`Navigation skills: ${skills.slugs.join(", ")}`);
    } else {
        logger.info("No skill pack found — planning from the graph only (run `sentinel skills` to add one).");
    }

    logger.info(`Planning with ${reasoner.modelLabel} ...`);
    const diff = await getPrDiff(prNumber, 6000, repoArg);
    const plan = await generatePlan(
        reasoner,
        {
            title: meta.title,
            body: meta.body,
            changedFiles,
            affectedRoutes: routes,
            diffExcerpt: diff,
            skills: skills?.text,
        },
        graph,
    );
    logPlan(plan);

    const runDir = args.runDir ?? path.join(outputDir, adapter.id, "verify-runs", `${prNumber}-${stamp()}`);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, "plan.json"), JSON.stringify(plan, null, 2));

    return {
        meta,
        changedFiles,
        routes,
        graph,
        plan,
        runDir,
        skillsUsed: skills?.slugs ?? [],
        skillsText: skills?.text ?? null,
    };
}

export interface RunVerifyArgs extends PlanArgs {
    /** The resolved preview URL (already non-null). The adapter's baseUrl must equal this. */
    targetUrl: string;
    /**
     * REQUIRED. The CLI passes env.allowProdWrites (preserving the local-dev write
     * path); the server ALWAYS passes false, so previews are unconditionally
     * clamped read-only and SENTINEL_ALLOW_PROD_WRITES can never leak into a run.
     */
    allowProdWrites: boolean;
}

export interface RunVerifyResult {
    manifest: VerifyManifest;
    runDir: string;
    blocked: BlockedRequest[];
}

/**
 * Plan a browser test for a PR, run it on the target URL (read-only, recorded),
 * judge whether the PR does what it claims, and write a redacted manifest. The
 * production preflight + read-only guard run for every invocation — there is no
 * code path here that reaches the browser without them.
 */
export async function runVerifyForProject(args: RunVerifyArgs): Promise<RunVerifyResult> {
    const { adapter, targetUrl, reasoner, env, allowProdWrites } = args;

    const credentials = adapter.credentials;
    if (adapter.authRequired && !credentials) {
        throw new Error(`No login configured for ${adapter.displayName} — set the project's credential env vars.`);
    }

    const { meta, changedFiles, routes, graph, plan, runDir, skillsUsed, skillsText } = await planForProject(args);

    // Exact baseline selectors for the affected routes, for selector-first execution.
    // Reads the same pack as the planner; null until `sentinel skills` has run.
    const pageSkills = loadPageSkillIndex(args.outputDir, adapter.id, graph, routes);
    if (pageSkills) {
        logger.info(`Page skills: ${pageSkills.slugs.join(", ")} (${pageSkills.routes.length} route(s))`);
    }

    logger.info(`Target: ${targetUrl}`);
    // The adapter is already scoped to targetUrl, so the preflight checks the real target.
    const preflight = await runProductionPreflight(adapter, allowProdWrites);
    await ensureAppReachable(targetUrl);

    const screenshotDir = path.join(runDir, "screenshots");
    fs.mkdirSync(screenshotDir, { recursive: true });
    const safety = { ...adapter.safety, readOnly: preflight.effectiveReadOnly };
    const session = await createSession({
        baseUrl: targetUrl,
        headless: env.headless,
        safety,
        videoDir: path.join(runDir, "video"),
    });

    const destructive = adapter.safety.destructiveControlPatterns.map((p) => new RegExp(p, "i"));
    let videoPath: string | null = null;
    let results: StepResult[] = [];
    let recoveries = 0;
    let replanned = false;
    let verdict: Verdict = { outcome: "uncertain", confidence: "low", summary: "Not executed.", evidence: [] };
    try {
        if (adapter.authRequired && credentials) {
            logger.info("Authenticating ...");
            await performLogin(session.page, adapter.auth, credentials, { timeoutMs: env.loginTimeoutMs });
            logger.success("Authenticated. Executing the plan ...");
        } else {
            logger.info("No login required — executing the plan directly ...");
        }
        // Reach the entry point the way a person does: the app opens on its own
        // landing page, so click through its menus/sidebar to the start route rather
        // than typing a URL. navigateLikeUser loads a URL directly only when there is
        // no in-app route — so the recording shows a real navigation, not a jump,
        // whenever the interaction map allows (which, with a baseline crawl, is every
        // top-level route).
        if (plan.startRoute) {
            const startPath = toTargetPath(plan.startRoute);
            await waitForInteractive(session.page, 6000).catch(() => {});
            const startOutcome = await navigateLikeUser(session.page, startPath, graph, {
                destructive,
                baseUrl: targetUrl,
                loginPath: adapter.auth.loginPath,
                settleMs: 6000,
                navTimeoutMs: env.loginTimeoutMs,
                clickTimeoutMs: 8000,
            }).catch(() => null);
            if (startOutcome) {
                logger.info(`Start: ${startOutcome.observation}`);
            }
        }
        const outcome = await executePlan(session, plan, {
            reasoner,
            destructive,
            settleMs: 6000,
            navTimeoutMs: env.loginTimeoutMs,
            clickTimeoutMs: 8000,
            screenshotDir,
            pacing: pacingFromEnv(env),
            loginPath: adapter.auth.loginPath,
            graph,
            pageSkills,
            selfCorrect: env.selfCorrect
                ? {
                      maxRecoveries: env.maxRecoveries,
                      maxReplans: env.maxReplans,
                      prTitle: meta.title,
                      prBody: meta.body,
                      skillsText,
                  }
                : null,
        });
        results = outcome.results;
        recoveries = outcome.recoveries;
        replanned = outcome.replanned;
        logger.info("Judging ...");
        verdict = await judgeVerdict(reasoner, meta.title, meta.body, plan, results, { recoveries, replanned });
    } finally {
        videoPath = await closeQuietly(session.close);
    }

    const manifest: VerifyManifest = {
        pr: meta.number,
        title: meta.title,
        body: meta.body,
        headSha: meta.headSha,
        headRef: meta.headRef,
        targetUrl,
        changedFiles,
        affectedRoutes: routes,
        skillsUsed,
        pageSkillsUsed: pageSkills?.slugs ?? [],
        readOnly: preflight.effectiveReadOnly,
        blockedWrites: session.blocked.filter((b) => b.reason === "mutation").length,
        recoveries,
        replanned,
        model: reasoner.modelLabel,
        plan,
        results,
        verdict,
        video: videoPath,
        createdAt: new Date().toISOString(),
    };
    // The manifest is a shared artifact (a PR comment is built from it) — redact before disk.
    fs.writeFileSync(path.join(runDir, "manifest.json"), redactSecret(JSON.stringify(manifest, null, 2)));
    logVerdict(manifest);

    // Inert skill-drift proposals — written to the run dir only, NEVER to skills/. Promotion
    // is a separate, baseline-gated step (`skills reconcile`); this is just surfaced signal.
    const proposals = buildSkillProposals(
        results.flatMap((r) => r.discrepancies ?? []),
        {
            pr: meta.number,
            headSha: meta.headSha,
            baselineGitSha: graph.gitSha,
            targetUrl,
            createdAt: new Date().toISOString(),
        },
    );
    if (proposals) {
        fs.writeFileSync(path.join(runDir, "skill-proposals.json"), redactSecret(JSON.stringify(proposals, null, 2)));
        logger.warn(
            `Skill drift: ${proposals.proposals.length} proposal(s) → skill-proposals.json (baseline may be out of date; no skills/ changes).`,
        );
    }

    return { manifest, runDir, blocked: session.blocked };
}
