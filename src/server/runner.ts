import * as fs from "node:fs";
import * as path from "node:path";
import {
    adapterForProject,
    createReasoner,
    endRun,
    getPrMeta,
    llmCredentialIssue,
    loadEnvConfig,
    logger,
    redactSecret,
    resolveWebPreviewUrl,
    runCrawlForProject,
    runVerifyForProject,
    runWithProgress,
    startRun,
} from "../index";
import { formatErrorComment, formatVerdictComment, postVerdict } from "./comment";
import { dashboardUrl, loadServerConfig } from "./config";
import { publishCrawlDone, publishDone, publishError } from "./sse";
import { upsertRunRecord } from "./store";
import type { ProjectRecord, RunRecord, RunStatus } from "./types";

function msg(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function stamp(): string {
    return new Date().toISOString().replace(/[:.]/g, "-");
}

/**
 * runId encodes the run directory name so it round-trips through resolveRunArtifacts
 * (and matches the gallery's manifest-derived ids): `<projectId>__<pr>-<stamp>`. The
 * projectId/adapterId never contains "__", and the dir name never contains "__", so
 * the single "__" is an unambiguous split point.
 */
function makeRunId(projectId: string, pr: number): string {
    return `${projectId}__${pr}-${stamp()}`;
}

/** Global slot semaphore — bounds total concurrent runs (default 1). */
let activeSlots = 0;
const slotWaiters: Array<() => void> = [];
function acquireSlot(max: number): Promise<void> {
    return new Promise<void>((resolve) => {
        const attempt = (): void => {
            if (activeSlots < max) {
                activeSlots += 1;
                resolve();
            } else {
                slotWaiters.push(attempt);
            }
        };
        attempt();
    });
}
function releaseSlot(): void {
    activeSlots -= 1;
    const next = slotWaiters.shift();
    if (next) {
        next();
    }
}

/** Per-(repo#pr) guard so the same PR never runs twice at once. Single-owner: see runProject. */
const inFlight = new Set<string>();
export function isPrRunning(repo: string, pr: number): boolean {
    return inFlight.has(`${repo}#${pr}`);
}

function statusFromVerdict(outcome: "pass" | "fail" | "uncertain"): RunStatus {
    if (outcome === "pass") {
        return "passed";
    }
    if (outcome === "fail") {
        return "failed";
    }
    return "uncertain";
}

export interface RunOptions {
    /** Pre-chosen runId (so the manual-trigger API can return it before the run finishes). */
    runId?: string;
    /** Pre-resolved preview URL (the poller resolves it once and threads it in). */
    targetUrl?: string | null;
}

/**
 * Run a project's verify pipeline for a PR, post the verdict back (when mention-
 * triggered), stream progress, and persist a RunRecord. Preconditions (no LLM, no
 * credentials, no preview, no baseline graph) are surfaced as a run, never a crash.
 * The server ALWAYS runs read-only — allowProdWrites is hard-wired false and the
 * adapter's read-only flag is forced on, so neither a remote nor a (mis)local target
 * can become a write path.
 */
export async function runProject(
    project: ProjectRecord,
    prNumber: number,
    triggerCommentId: number | null,
    opts: RunOptions = {},
): Promise<{ runId: string; status: RunStatus }> {
    const env = loadEnvConfig();
    const config = loadServerConfig();
    const repo = project.repo;
    const runId = opts.runId ?? makeRunId(project.id, prNumber);
    const prefix = `${project.id}__`;
    const dirName = runId.startsWith(prefix) ? runId.slice(prefix.length) : `${prNumber}-${stamp()}`;
    const runDir = path.join(env.outputDir, project.id, "verify-runs", dirName);
    const flightKey = `${repo}#${prNumber}`;

    // Single owner per PR: never start a second run while one is in flight (no record, no post).
    if (inFlight.has(flightKey)) {
        return { runId, status: "blocked" };
    }
    inFlight.add(flightKey);

    const record: RunRecord = {
        runId,
        projectId: project.id,
        repo,
        pr: prNumber,
        title: `PR #${prNumber}`,
        status: "running",
        triggerCommentId,
        runDir: null,
        manifestPath: null,
        videoPath: null,
        verdict: null,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        error: null,
    };

    const fail = async (status: RunStatus, reason: string): Promise<{ runId: string; status: RunStatus }> => {
        record.status = status;
        record.error = redactSecret(reason);
        record.finishedAt = new Date().toISOString();
        await upsertRunRecord(record);
        publishError(runId, reason);
        if (triggerCommentId !== null) {
            try {
                await postVerdict(repo, prNumber, formatErrorComment(reason, { runId }));
            } catch (error) {
                logger.warn(`Could not post comment to ${repo}#${prNumber}: ${msg(error)}`);
            }
        }
        return { runId, status };
    };

    try {
        await upsertRunRecord(record);

        const llmIssue = llmCredentialIssue(env.llmProvider);
        if (llmIssue) {
            return await fail(
                "blocked",
                `I can't verify this yet — the language model isn't configured (${llmIssue}).`,
            );
        }

        let targetUrl = opts.targetUrl ?? null;
        let adapter: ReturnType<typeof adapterForProject>;
        try {
            adapter = adapterForProject(project, env, { baseUrl: targetUrl ?? "" });
        } catch (error) {
            return await fail("errored", `Adapter error: ${msg(error)}`);
        }
        if (!adapter.credentials) {
            return await fail(
                "blocked",
                `I can't verify this yet — no test credentials are configured for ${project.displayName}.`,
            );
        }

        if (!targetUrl) {
            let headSha: string;
            try {
                const meta = await getPrMeta(prNumber, repo);
                headSha = meta.headSha;
                record.title = redactSecret(meta.title);
            } catch (error) {
                return await fail("errored", `Could not read PR #${prNumber}: ${msg(error)}`);
            }
            targetUrl = await resolveWebPreviewUrl(repo, headSha, project.previewEnvIncludes);
            if (!targetUrl) {
                return await fail("blocked", `No ready preview deployment found for PR #${prNumber} yet.`);
            }
            adapter = adapterForProject(project, env, { baseUrl: targetUrl });
        }

        // The server ALWAYS runs read-only, regardless of any adapter/env default.
        adapter.safety = { ...adapter.safety, readOnly: true };

        const graphFile = path.join(env.outputDir, project.id, "graph", "latest.json");
        if (!fs.existsSync(graphFile)) {
            return await fail(
                "blocked",
                `I need a baseline crawl of ${project.displayName} before I can verify its PRs — run a baseline crawl first.`,
            );
        }

        // Acquire a slot ONLY around the browser run, inside a try/finally that always releases it.
        await acquireSlot(config.maxConcurrent);
        try {
            const reasoner = createReasoner(env);
            startRun(`verify-${prNumber}`, {
                pr: prNumber,
                kind: "verify-server",
                model: reasoner.modelLabel,
                project: project.id,
            });
            try {
                const { manifest, runDir: usedDir } = await runWithProgress(runId, () =>
                    runVerifyForProject({
                        adapter,
                        repo,
                        prNumber,
                        targetUrl,
                        reasoner,
                        env,
                        outputDir: env.outputDir,
                        runDir,
                        // The server NEVER enables writes.
                        allowProdWrites: false,
                    }),
                );
                record.runDir = usedDir;
                record.manifestPath = path.join(usedDir, "manifest.json");
                record.videoPath = manifest.video;
                record.title = redactSecret(manifest.title);
                // Redact the persisted/served verdict (it's free LLM text built from the PR body).
                record.verdict = {
                    ...manifest.verdict,
                    summary: redactSecret(manifest.verdict.summary),
                    evidence: manifest.verdict.evidence.map(redactSecret),
                };
                record.status = statusFromVerdict(manifest.verdict.outcome);
                record.finishedAt = new Date().toISOString();
                await upsertRunRecord(record);

                const videoUrl = manifest.video ? `/api/runs/${encodeURIComponent(runId)}/video` : null;
                if (triggerCommentId !== null) {
                    try {
                        await postVerdict(
                            repo,
                            prNumber,
                            formatVerdictComment(manifest, { runId, videoUrl, dashboardUrl: dashboardUrl() }),
                        );
                    } catch (error) {
                        logger.warn(`Could not post verdict to ${repo}#${prNumber}: ${msg(error)}`);
                    }
                }
                publishDone(runId, { verdict: manifest.verdict, videoUrl });
                return { runId, status: record.status };
            } finally {
                await endRun();
            }
        } catch (error) {
            return await fail("errored", `Run failed: ${msg(error)}`);
        } finally {
            releaseSlot();
        }
    } finally {
        inFlight.delete(flightKey);
    }
}

/**
 * Kick off a run without awaiting it (for the manual-trigger API). Returns the
 * runId immediately so the client can attach to the SSE stream.
 */
export function triggerRunInBackground(
    project: ProjectRecord,
    prNumber: number,
    triggerCommentId: number | null,
): string {
    const runId = makeRunId(project.id, prNumber);
    void runProject(project, prNumber, triggerCommentId, { runId }).catch((error) => {
        logger.warn(`Run ${runId} crashed: ${msg(error)}`);
    });
    return runId;
}

/** Per-project guard so one project isn't crawled twice at once. */
const crawlInFlight = new Set<string>();
export function isCrawlRunning(projectId: string): boolean {
    return crawlInFlight.has(projectId);
}

function resolveBaselineUrl(project: ProjectRecord, env: ReturnType<typeof loadEnvConfig>): string {
    return project.baselineUrl || env.baseUrl || "";
}

export interface CrawlOptions {
    runId?: string;
    maxPages?: number;
    actuationsPerPage?: number;
    /** false forces a link-only crawl even when an LLM is configured. */
    interact?: boolean;
}

/**
 * Build the baseline interaction graph for a project from the dashboard. Mirrors
 * runProject: streams progress, reuses the SAME global slot semaphore + Langfuse
 * bracketing (so crawl and verify never run concurrently and never cross-contaminate
 * the process-global trace), and is forced read-only. Surfaces preconditions as a
 * blocked run rather than crashing.
 */
export async function crawlProject(
    project: ProjectRecord,
    opts: CrawlOptions = {},
): Promise<{ runId: string; status: RunStatus }> {
    const env = loadEnvConfig();
    const config = loadServerConfig();
    const runId = opts.runId ?? `${project.id}__crawl-${stamp()}`;
    const flightKey = project.id;

    if (crawlInFlight.has(flightKey)) {
        return { runId, status: "blocked" };
    }
    crawlInFlight.add(flightKey);

    const record: RunRecord = {
        runId,
        projectId: project.id,
        repo: project.repo,
        pr: 0,
        title: `${project.repo} — baseline crawl`,
        kind: "crawl",
        status: "running",
        triggerCommentId: null,
        runDir: null,
        manifestPath: null,
        videoPath: null,
        verdict: null,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        error: null,
    };

    const fail = async (status: RunStatus, reason: string): Promise<{ runId: string; status: RunStatus }> => {
        record.status = status;
        record.error = redactSecret(reason);
        record.finishedAt = new Date().toISOString();
        await upsertRunRecord(record);
        publishError(runId, reason);
        return { runId, status };
    };

    try {
        await upsertRunRecord(record);

        const baselineUrl = resolveBaselineUrl(project, env);
        if (!baselineUrl) {
            return await fail("blocked", "Set a baseline URL for this project first (the URL Sentinel should crawl).");
        }

        let adapter: ReturnType<typeof adapterForProject>;
        try {
            adapter = adapterForProject(project, env, { baseUrl: baselineUrl });
        } catch (error) {
            return await fail("errored", `Adapter error: ${msg(error)}`);
        }
        if (!adapter.credentials) {
            return await fail("blocked", `No test credentials are configured for ${project.displayName}.`);
        }
        // The server ALWAYS crawls read-only.
        adapter.safety = { ...adapter.safety, readOnly: true };

        await acquireSlot(config.maxConcurrent);
        try {
            const llmIssue = llmCredentialIssue(env.llmProvider);
            // Crawl degrades to link-only without an LLM (not blocked).
            const reasoner = opts.interact === false || llmIssue ? null : createReasoner(env);
            startRun(`crawl-${project.id}`, {
                kind: "crawl-server",
                model: reasoner?.modelLabel ?? "link-only",
                project: project.id,
            });
            try {
                const result = await runWithProgress(runId, () =>
                    runCrawlForProject({
                        adapter,
                        env,
                        outputDir: env.outputDir,
                        maxPages: opts.maxPages ?? 40,
                        actuationsPerPage: opts.actuationsPerPage ?? 6,
                        reasoner,
                        gitSha: null,
                    }),
                );
                record.status = "passed";
                record.finishedAt = new Date().toISOString();
                await upsertRunRecord(record);
                const c = result.coverage;
                publishCrawlDone(runId, {
                    coverage: {
                        nodeCount: c.nodeCount,
                        edgeCount: c.edgeCount,
                        routesReached: c.routesReached.length,
                        routesUnreached: c.routesUnreached.length,
                    },
                    graphPresent: true,
                });
                return { runId, status: record.status };
            } finally {
                await endRun();
            }
        } catch (error) {
            return await fail("errored", `Crawl failed: ${msg(error)}`);
        } finally {
            releaseSlot();
        }
    } finally {
        crawlInFlight.delete(flightKey);
    }
}

export function triggerCrawlInBackground(project: ProjectRecord, opts: CrawlOptions = {}): string {
    const runId = `${project.id}__crawl-${stamp()}`;
    void crawlProject(project, { ...opts, runId }).catch((error) => {
        logger.warn(`Crawl ${runId} crashed: ${msg(error)}`);
    });
    return runId;
}
