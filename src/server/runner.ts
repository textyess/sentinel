import * as fs from "node:fs";
import * as path from "node:path";
import type { GenericProjectConfig, PersistedRunRecipe } from "../index";
import {
    adapterForProject,
    checkoutPr,
    checkoutRepo,
    createReasoner,
    detectProjectConfig,
    endRun,
    GENERIC_SAFETY_DEFAULTS,
    generateSkillPack,
    getPrMeta,
    isGhAuthenticated,
    launchLocalApp,
    llmCredentialIssue,
    loadEnvConfig,
    loadGraph,
    logger,
    redactSecret,
    resolvePersistedRecipe,
    resolveProductionUrl,
    resolveWebPreviewUrl,
    runCrawlForProject,
    runVerifyForProject,
    runWithProgress,
    scanRepo,
    startRun,
    stripQuery,
} from "../index";
import { formatErrorComment, formatVerdictComment, postVerdict } from "./comment";
import { loadServerConfig, reportUrl } from "./config";
import { credEnvNames, slug } from "./naming";
import { singleton } from "./singleton";
import {
    primeStream,
    publishAutodetectDone,
    publishCrawlDone,
    publishDone,
    publishError,
    publishSkillsDone,
    publishTrialDone,
} from "./sse";
import { upsertRunRecord } from "./store";
import type { AutodetectProposal, ProjectRecord, RunRecord, RunStatus } from "./types";

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
const slots = singleton("runner.slots", () => ({ active: 0, waiters: [] as Array<() => void> }));
function acquireSlot(max: number): Promise<void> {
    return new Promise<void>((resolve) => {
        const attempt = (): void => {
            if (slots.active < max) {
                slots.active += 1;
                resolve();
            } else {
                slots.waiters.push(attempt);
            }
        };
        attempt();
    });
}
function releaseSlot(): void {
    slots.active -= 1;
    const next = slots.waiters.shift();
    if (next) {
        next();
    }
}

/** Per-(repo#pr) guard so the same PR never runs twice at once. Single-owner: see runProject. */
const inFlight = singleton("runner.inFlight", () => new Set<string>());
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
        if (adapter.authRequired && !adapter.credentials) {
            return await fail(
                "blocked",
                `I can't verify this yet — no test credentials are configured for ${project.displayName}.`,
            );
        }

        // When the PR has no preview deployment but the project declares a run recipe,
        // Sentinel starts the app itself from the PR branch. The heavy work (checkout,
        // install, dev server) runs inside the slot below; here we only decide the path.
        let bringUpRecipe: PersistedRunRecipe | null = null;
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
            if (targetUrl) {
                adapter = adapterForProject(project, env, { baseUrl: targetUrl });
            } else if (project.runRecipe) {
                bringUpRecipe = project.runRecipe;
            } else {
                return await fail(
                    "blocked",
                    `No ready preview deployment found for PR #${prNumber} yet, and no run recipe is configured to start it locally.`,
                );
            }
        }

        // The server ALWAYS runs read-only, regardless of any adapter/env default. (Also
        // re-applied after a local bring-up rebuilds the adapter, so a self-hosted target
        // whose backend points at prod still can't be written to.)
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
        // Stops a locally-started app + removes its checkout; a no-op for the preview path.
        let teardownLocal: () => Promise<void> = async () => {};
        try {
            if (bringUpRecipe) {
                const checkoutRoot = path.join(env.outputDir, project.id, "checkouts");
                const checkout = await checkoutPr(repo, prNumber, checkoutRoot);
                teardownLocal = () => checkout.cleanup();
                const resolved = resolvePersistedRecipe(bringUpRecipe);
                // A name reserved for Sentinel's own credentials must never start the app —
                // this is a security backstop behind the API validation. (teardownLocal still
                // fires in the slot's finally, so the checkout is cleaned up.)
                if (resolved.rejectedSecrets.length > 0) {
                    return await fail(
                        "blocked",
                        `I won't start ${project.displayName} for this PR — its run recipe references env vars reserved for Sentinel's own credentials: ${resolved.rejectedSecrets.join(", ")}. Remove them from the recipe.`,
                    );
                }
                // A declared secret that isn't configured means the app would boot degraded and
                // the verdict would judge a broken app — surface it as blocked, like missing creds.
                if (resolved.missingSecrets.length > 0) {
                    return await fail(
                        "blocked",
                        `I can't start ${project.displayName} for this PR — its run recipe declares secrets that aren't set: ${resolved.missingSecrets.join(", ")}. Add them in Settings and re-run.`,
                    );
                }
                const app = await launchLocalApp(resolved.recipe, { cwd: checkout.dir });
                teardownLocal = async () => {
                    await app.stop();
                    await checkout.cleanup();
                };
                targetUrl = app.baseUrl;
                adapter = adapterForProject(project, env, { baseUrl: targetUrl });
                adapter.safety = { ...adapter.safety, readOnly: true };
                logger.info(`Self-hosting ${repo}#${prNumber} at ${targetUrl} (no preview deployment found).`);
            }
            if (!targetUrl) {
                // Unreachable: a preview/opts URL or the local bring-up above always sets it.
                throw new Error("internal: target URL was not resolved before verify.");
            }
            // Capture into a const so the narrowing survives into the runWithProgress closure
            // (targetUrl is a reassigned `let`, so TS widens it back to string|null otherwise).
            const verifyTargetUrl = targetUrl;
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
                        targetUrl: verifyTargetUrl,
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
                    // The comment is just a link to the run's report page — the verdict, plan,
                    // results, and recording all live there. Set SENTINEL_DASHBOARD_URL so the
                    // link resolves for reviewers (it defaults to the operator's local address).
                    try {
                        await postVerdict(
                            repo,
                            prNumber,
                            formatVerdictComment(manifest, { runId, reportUrl: reportUrl(runId) }),
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
            // Always reap a locally-started app + its checkout, on success or failure.
            await teardownLocal().catch((error) => logger.warn(`Local teardown failed: ${msg(error)}`));
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
    primeStream(runId);
    void runProject(project, prNumber, triggerCommentId, { runId }).catch((error) => {
        logger.warn(`Run ${runId} crashed: ${msg(error)}`);
    });
    return runId;
}

/** Per-project guard so one project isn't crawled twice at once. */
const crawlInFlight = singleton("runner.crawlInFlight", () => new Set<string>());
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

        let baselineUrl = resolveBaselineUrl(project, env);
        // No baseline URL but a run recipe → self-host the default branch for the crawl,
        // so a no-preview project can build its baseline without an external URL. The heavy
        // bring-up runs inside the slot below.
        let bringUpRecipe: PersistedRunRecipe | null = null;
        if (!baselineUrl) {
            if (project.runRecipe) {
                bringUpRecipe = project.runRecipe;
            } else {
                return await fail(
                    "blocked",
                    "Set a baseline URL for this project first (the URL Sentinel should crawl), or add a run recipe so Sentinel can start it.",
                );
            }
        }

        let adapter: ReturnType<typeof adapterForProject>;
        try {
            adapter = adapterForProject(project, env, { baseUrl: baselineUrl });
        } catch (error) {
            return await fail("errored", `Adapter error: ${msg(error)}`);
        }
        if (adapter.authRequired && !adapter.credentials) {
            return await fail("blocked", `No test credentials are configured for ${project.displayName}.`);
        }
        // The server ALWAYS crawls read-only.
        adapter.safety = { ...adapter.safety, readOnly: true };

        await acquireSlot(config.maxConcurrent);
        // Stops a locally-started app + removes its checkout; a no-op when crawling a URL.
        let teardownLocal: () => Promise<void> = async () => {};
        try {
            if (bringUpRecipe) {
                const checkoutRoot = path.join(env.outputDir, project.id, "checkouts");
                const checkout = await checkoutRepo(project.repo, checkoutRoot);
                teardownLocal = () => checkout.cleanup();
                const resolved = resolvePersistedRecipe(bringUpRecipe);
                if (resolved.rejectedSecrets.length > 0) {
                    return await fail(
                        "blocked",
                        `I won't start ${project.displayName} — its run recipe references env vars reserved for Sentinel's own credentials: ${resolved.rejectedSecrets.join(", ")}. Remove them from the recipe.`,
                    );
                }
                if (resolved.missingSecrets.length > 0) {
                    return await fail(
                        "blocked",
                        `I can't start ${project.displayName} — its run recipe declares secrets that aren't set: ${resolved.missingSecrets.join(", ")}. Add them in Settings and re-run.`,
                    );
                }
                const app = await launchLocalApp(resolved.recipe, { cwd: checkout.dir });
                teardownLocal = async () => {
                    await app.stop();
                    await checkout.cleanup();
                };
                baselineUrl = app.baseUrl;
                adapter = adapterForProject(project, env, { baseUrl: baselineUrl });
                adapter.safety = { ...adapter.safety, readOnly: true };
                logger.info(`Self-hosting ${project.repo} (default branch) at ${baselineUrl} for the baseline crawl.`);
            }
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
            // Always reap a locally-started app + its checkout, on success or failure.
            await teardownLocal().catch((error) => logger.warn(`Local teardown failed: ${msg(error)}`));
            releaseSlot();
        }
    } finally {
        crawlInFlight.delete(flightKey);
    }
}

export function triggerCrawlInBackground(project: ProjectRecord, opts: CrawlOptions = {}): string {
    const runId = `${project.id}__crawl-${stamp()}`;
    primeStream(runId);
    void crawlProject(project, { ...opts, runId }).catch((error) => {
        logger.warn(`Crawl ${runId} crashed: ${msg(error)}`);
    });
    return runId;
}

/** Per-project guard so one project's skills aren't authored twice at once. */
const skillsInFlight = singleton("runner.skillsInFlight", () => new Set<string>());
export function isSkillsRunning(projectId: string): boolean {
    return skillsInFlight.has(projectId);
}

/**
 * Author the navigation skill pack for a project from the dashboard. Mirrors
 * crawlProject: shares the global slot semaphore + Langfuse bracketing (so it never
 * runs concurrently with a crawl/verify or cross-contaminates the process-global
 * trace) and streams progress. The LLM is required and the baseline graph must exist;
 * both preconditions surface as a blocked run rather than a crash.
 */
export async function generateSkillsProject(
    project: ProjectRecord,
    opts: { runId?: string } = {},
): Promise<{ runId: string; status: RunStatus }> {
    const env = loadEnvConfig();
    const config = loadServerConfig();
    const runId = opts.runId ?? `${project.id}__skills-${stamp()}`;
    const flightKey = project.id;

    if (skillsInFlight.has(flightKey)) {
        return { runId, status: "blocked" };
    }
    skillsInFlight.add(flightKey);

    const record: RunRecord = {
        runId,
        projectId: project.id,
        repo: project.repo,
        pr: 0,
        title: `${project.repo} — skill pack`,
        kind: "skills",
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

        const llmIssue = llmCredentialIssue(env.llmProvider);
        if (llmIssue) {
            return await fail(
                "blocked",
                `Skill authoring needs the language model — it isn't configured (${llmIssue}).`,
            );
        }
        const graphFile = path.join(env.outputDir, project.id, "graph", "latest.json");
        if (!fs.existsSync(graphFile)) {
            return await fail(
                "blocked",
                `I need a baseline crawl of ${project.displayName} before I can author skills — build the baseline first.`,
            );
        }

        await acquireSlot(config.maxConcurrent);
        try {
            const reasoner = createReasoner(env);
            startRun(`skills-${project.id}`, {
                kind: "skills-server",
                model: reasoner.modelLabel,
                project: project.id,
            });
            try {
                const graph = loadGraph(graphFile);
                const pack = await runWithProgress(runId, () => {
                    logger.info(`Authoring skills for ${project.displayName} from the baseline graph ...`);
                    return generateSkillPack({ graph, outputDir: env.outputDir, adapterId: project.id, reasoner });
                });
                record.status = "passed";
                record.finishedAt = new Date().toISOString();
                await upsertRunRecord(record);
                publishSkillsDone(runId, { skillCount: pack.skillCount, areas: pack.manifest.areas.length });
                return { runId, status: record.status };
            } finally {
                await endRun();
            }
        } catch (error) {
            return await fail("errored", `Skill authoring failed: ${msg(error)}`);
        } finally {
            releaseSlot();
        }
    } finally {
        skillsInFlight.delete(flightKey);
    }
}

export function triggerSkillsInBackground(project: ProjectRecord): string {
    const runId = `${project.id}__skills-${stamp()}`;
    primeStream(runId);
    void generateSkillsProject(project, { runId }).catch((error) => {
        logger.warn(`Skills ${runId} crashed: ${msg(error)}`);
    });
    return runId;
}

/** Per-repo guard so one repo isn't trial-brought-up twice at once. Keyed by "owner/name". */
const trialInFlight = singleton("runner.trialInFlight", () => new Set<string>());
export function isTrialRunning(repo: string): boolean {
    return trialInFlight.has(repo);
}

export interface TrialBringUpInput {
    repo: string;
    runRecipe: PersistedRunRecipe;
    runId?: string;
}

/**
 * "Prove it" onboarding check: clone the default branch, run the recipe, and confirm the
 * app answers HTTP — then tear it all down. No LLM, no baseline, no credentials; it only
 * answers "can Sentinel actually start this app?" so a no-preview project can validate its
 * recipe before the first PR. Streams progress and shares the global run slot + read-only
 * isolation (the spawned child never receives Sentinel's own secrets).
 */
export async function trialBringUp(input: TrialBringUpInput): Promise<{ runId: string; status: RunStatus }> {
    const env = loadEnvConfig();
    const config = loadServerConfig();
    const runId = input.runId ?? `${slug(input.repo)}__trial-${stamp()}`;
    const flightKey = input.repo;

    if (trialInFlight.has(flightKey)) {
        return { runId, status: "blocked" };
    }
    trialInFlight.add(flightKey);

    try {
        const resolved = resolvePersistedRecipe(input.runRecipe);
        if (resolved.rejectedSecrets.length > 0) {
            publishError(
                runId,
                `The run recipe references env vars reserved for Sentinel's own credentials: ${resolved.rejectedSecrets.join(", ")}. Remove them.`,
            );
            return { runId, status: "errored" };
        }
        if (resolved.missingSecrets.length > 0) {
            publishError(
                runId,
                `The run recipe declares secrets that aren't set: ${resolved.missingSecrets.join(", ")}. Add them in Settings and try again.`,
            );
            return { runId, status: "blocked" };
        }

        await acquireSlot(config.maxConcurrent);
        let teardownLocal: () => Promise<void> = async () => {};
        try {
            const baseUrl = await runWithProgress(runId, async () => {
                const checkoutRoot = path.join(env.outputDir, slug(input.repo), "checkouts");
                const checkout = await checkoutRepo(input.repo, checkoutRoot);
                teardownLocal = () => checkout.cleanup();
                const app = await launchLocalApp(resolved.recipe, { cwd: checkout.dir });
                teardownLocal = async () => {
                    await app.stop();
                    await checkout.cleanup();
                };
                logger.success(`Bring-up succeeded — ${input.repo} is reachable at ${app.baseUrl}.`);
                return app.baseUrl;
            });
            publishTrialDone(runId, { ok: true, baseUrl });
            return { runId, status: "passed" };
        } catch (error) {
            publishError(runId, `Bring-up failed: ${msg(error)}`);
            return { runId, status: "errored" };
        } finally {
            await teardownLocal().catch((error) => logger.warn(`Local teardown failed: ${msg(error)}`));
            releaseSlot();
        }
    } finally {
        trialInFlight.delete(flightKey);
    }
}

export function triggerTrialBringUpInBackground(input: Omit<TrialBringUpInput, "runId">): string {
    const runId = `${slug(input.repo)}__trial-${stamp()}`;
    primeStream(runId);
    void trialBringUp({ ...input, runId }).catch((error) => {
        logger.warn(`Trial bring-up ${runId} crashed: ${msg(error)}`);
    });
    return runId;
}

/** Per-repo guard so one repo isn't auto-detected twice at once. Keyed by "owner/name". */
const autodetectInFlight = singleton("runner.autodetectInFlight", () => new Set<string>());
export function isAutodetectRunning(repo: string): boolean {
    return autodetectInFlight.has(repo);
}

export interface AutodetectInput {
    repo: string;
    baselineUrl: string | null;
    /** Preview-deployment substring (defaults to "web") — used to resolve a baseline and echoed back. */
    previewEnvIncludes?: string;
    /** Pre-chosen runId so the trigger can return it before the run finishes. */
    runId?: string;
}

/**
 * Observe a live app (and optionally scan the repo) to propose a generic-project
 * config the user can register without hand-typing every field. Mirrors crawlProject:
 * shares the global slot + Langfuse bracketing, streams progress, and is ALWAYS
 * read-only — detection only reads the login page, never submits it. The proposal is
 * stored on the RunRecord and pushed over SSE; nothing is registered automatically and
 * the proposed mutation allow-list is never applied here.
 */
export async function autodetectProject(input: AutodetectInput): Promise<{ runId: string; status: RunStatus }> {
    const env = loadEnvConfig();
    const config = loadServerConfig();
    const projectId = slug(input.repo);
    const runId = input.runId ?? `${projectId}__autodetect-${stamp()}`;
    const flightKey = input.repo;

    if (autodetectInFlight.has(flightKey)) {
        return { runId, status: "blocked" };
    }
    autodetectInFlight.add(flightKey);

    const record: RunRecord = {
        runId,
        projectId,
        repo: input.repo,
        pr: 0,
        title: `${input.repo} — config auto-detect`,
        kind: "autodetect",
        status: "running",
        triggerCommentId: null,
        runDir: null,
        manifestPath: null,
        videoPath: null,
        verdict: null,
        proposedConfig: null,
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

        const llmIssue = llmCredentialIssue(env.llmProvider);
        if (llmIssue) {
            return await fail("blocked", `Auto-detect needs the language model — it isn't configured (${llmIssue}).`);
        }

        const previewEnvIncludes = input.previewEnvIncludes?.trim() || "web";
        const ghOk = await isGhAuthenticated();
        let resolvedBaseline = input.baselineUrl;
        if (!resolvedBaseline && ghOk) {
            resolvedBaseline = await resolveProductionUrl(input.repo, previewEnvIncludes);
        }
        if (!resolvedBaseline) {
            return await fail("blocked", "Provide a baseline URL to auto-detect from (the app's live URL).");
        }
        const baselineUrl = resolvedBaseline;

        // The slot is held ONLY around the browser/LLM work, exactly like crawl/verify.
        await acquireSlot(config.maxConcurrent);
        try {
            const reasoner = createReasoner(env);
            startRun(`autodetect-${projectId}`, {
                kind: "autodetect-server",
                model: reasoner.modelLabel,
                project: projectId,
            });
            try {
                const proposal = await runWithProgress(runId, async () => {
                    const repoScan = ghOk ? await scanRepo(input.repo) : null;
                    if (!ghOk) {
                        logger.warn("GitHub CLI not authenticated — skipping repository scan (pages prefix).");
                    }
                    return detectProjectConfig({
                        reasoner,
                        baseUrl: baselineUrl,
                        headless: env.headless,
                        telemetryPatterns: GENERIC_SAFETY_DEFAULTS.telemetryPatterns,
                        destructiveControlPatterns: GENERIC_SAFETY_DEFAULTS.destructiveControlPatterns,
                        repoScan,
                        previewEnvIncludes,
                    });
                });

                const creds = credEnvNames(input.repo);
                const adapter: GenericProjectConfig = {
                    auth: proposal.auth,
                    authRequired: proposal.authRequired,
                    emailEnv: creds.emailEnv,
                    passwordEnv: creds.passwordEnv,
                    previewEnvIncludes: proposal.previewEnvIncludes,
                    pagesPrefix: proposal.pagesPrefix ?? undefined,
                    knownRoutes: proposal.knownRoutes,
                    allowedMutationPatterns: proposal.allowedMutationPatterns,
                };
                const result: AutodetectProposal = {
                    repo: input.repo,
                    // Strip query+hash so a one-time bypass/login token never lands at rest or on the wire.
                    baselineUrl: stripQuery(baselineUrl),
                    previewEnvIncludes: proposal.previewEnvIncludes,
                    authRequired: proposal.authRequired,
                    adapter,
                    fieldMeta: proposal.fieldMeta,
                    notes: proposal.notes.map(redactSecret),
                };

                record.status = "passed";
                record.proposedConfig = result;
                record.finishedAt = new Date().toISOString();
                await upsertRunRecord(record);
                publishAutodetectDone(runId, result);
                return { runId, status: record.status };
            } finally {
                await endRun();
            }
        } catch (error) {
            return await fail("errored", `Auto-detect failed: ${msg(error)}`);
        } finally {
            releaseSlot();
        }
    } finally {
        autodetectInFlight.delete(flightKey);
    }
}

export function triggerAutodetectInBackground(input: AutodetectInput): string {
    const runId = `${slug(input.repo)}__autodetect-${stamp()}`;
    primeStream(runId);
    void autodetectProject({ ...input, runId }).catch((error) => {
        logger.warn(`Auto-detect ${runId} crashed: ${msg(error)}`);
    });
    return runId;
}
