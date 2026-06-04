import * as fs from "node:fs";
import * as path from "node:path";
import { getAdapter } from "./adapters";
import type { LoginResult } from "./core/auth/login";
import { performLogin } from "./core/auth/login";
import { ensureAppReachable } from "./core/bringup/app";
import type { DriverSession } from "./core/browser/driver";
import { createSession } from "./core/browser/driver";
import { loadEnvConfig, REPO_ROOT } from "./core/config";
import { crawl } from "./core/crawler/crawler";
import { currentGitSha, graphScreenshotDir, loadGraph, saveGraph } from "./core/graph/store";
import type { InteractionGraph } from "./core/graph/types";
import type { PacingOptions } from "./core/human/pacing";
import { logger } from "./core/logger";
import { endRun, runTotals, startRun } from "./core/observability/langfuse";
import type { PrMeta } from "./core/pr/github";
import { detectRepo, getChangedFiles, getPrDiff, getPrMeta, resolveWebPreviewUrl } from "./core/pr/github";
import { replayFlows, selectFlows } from "./core/pr/replay";
import type { FlowResult, PrRunManifest } from "./core/pr/types";
import { createReasoner, llmCredentialIssue } from "./core/reasoner/ai-sdk-reasoner";
import type { Reasoner } from "./core/reasoner/types";
import { runProductionPreflight } from "./core/safety/production-guard";
import { redactSecret } from "./core/safety/redact";
import { synthesizeSiteMap } from "./core/sitemap/synthesize";
import type { BlockedRequest, Credentials, RepoAdapter, SafetyConfig } from "./core/types";
import { executePlan, judgeVerdict } from "./core/verify/execute";
import { generatePlan } from "./core/verify/plan";
import type { StepResult, TestPlan, Verdict, VerifyManifest } from "./core/verify/types";

/** Filesystem-safe timestamp for run directories. */
function stamp(): string {
    return new Date().toISOString().replace(/[:.]/g, "-");
}

function requireCredentials(adapter: RepoAdapter): Credentials {
    if (!adapter.credentials) {
        throw new Error(
            "No login configured. Set SENTINEL_EMAIL and SENTINEL_PASSWORD in apps/qa-agent/.env " +
                "(copy apps/qa-agent/.env.example). When targeting prod, use a real account — the seeded " +
                "test users only exist in the local database.",
        );
    }
    return adapter.credentials;
}

function sessionAuthPath(outputDir: string, adapterId: string): string {
    return path.join(outputDir, adapterId, "auth", "session.json");
}

function pacingFromEnv(env: ReturnType<typeof loadEnvConfig>): PacingOptions {
    return { enabled: env.humanPacing, baseThinkMs: env.paceMs, maxDwellMs: env.maxDwellMs };
}

/** Flush the run's LLM trace and print the cost (+ Langfuse trace id when tracing is on). */
async function reportRunCost(): Promise<void> {
    const { traceId } = await endRun();
    const t = runTotals();
    if (t.calls === 0) {
        return;
    }
    logger.info(
        `LLM cost: ~$${t.costUsd.toFixed(4)} (${t.inputTokens} in + ${t.outputTokens} out tokens, ${t.calls} call(s)).`,
    );
    if (traceId) {
        const host = (process.env.LANGFUSE_BASEURL || process.env.LANGFUSE_HOST || "").replace(/\/$/, "");
        logger.info(`Langfuse trace: id=${traceId}${host ? ` (${host})` : ""}`);
    }
}

function reportBlocked(blocked: BlockedRequest[]): void {
    const mutations = blocked.filter((b) => b.reason === "mutation");
    const telemetry = blocked.filter((b) => b.reason === "telemetry");
    logger.info(`Read-only guard: blocked ${mutations.length} mutation(s), ${telemetry.length} telemetry call(s).`);
    for (const m of mutations.slice(0, 20)) {
        logger.warn(`  blocked ${m.method} ${m.url}`);
    }
    if (mutations.length > 20) {
        logger.warn(`  ... and ${mutations.length - 20} more`);
    }
}

/** The production / read-only preflight on its own. */
export async function runGuard(): Promise<void> {
    logger.banner("production / read-only preflight");
    const env = loadEnvConfig();
    const adapter = getAdapter();
    const result = await runProductionPreflight(adapter, env.allowProdWrites);
    logger.info(`Target:           ${adapter.baseUrl}`);
    logger.info(`Read-only active: ${result.effectiveReadOnly ? "yes" : "NO — writes allowed"}`);
}

/** Log in once and persist the authenticated browser session for reuse. */
export async function runLogin(): Promise<void> {
    logger.banner("login — capture an authenticated session");
    const env = loadEnvConfig();
    const adapter = getAdapter();

    const preflight = await runProductionPreflight(adapter, env.allowProdWrites);
    const credentials = requireCredentials(adapter);
    await ensureAppReachable(adapter.baseUrl);

    const storageStatePath = sessionAuthPath(env.outputDir, adapter.id);
    const safety: SafetyConfig = { ...adapter.safety, readOnly: preflight.effectiveReadOnly };
    const session = await createSession({ baseUrl: adapter.baseUrl, headless: env.headless, safety });

    try {
        const result = await performLogin(session.page, adapter.auth, credentials, { timeoutMs: env.loginTimeoutMs });
        fs.mkdirSync(path.dirname(storageStatePath), { recursive: true });
        await session.context.storageState({ path: storageStatePath });
        logger.success(`Logged in (${result.landedUrl}). Session saved -> ${storageStatePath}`);
    } finally {
        await closeQuietly(session.close);
    }
}

/**
 * Phase 0 smoke: prove the whole safety + drive + auth + record loop end to end.
 * Boot check -> preflight -> log in -> save session -> screenshot -> report.
 */
export async function runSmoke(): Promise<void> {
    logger.banner("Phase 0 smoke — boot, log in, screenshot, report");
    const env = loadEnvConfig();
    const adapter = getAdapter();

    const preflight = await runProductionPreflight(adapter, env.allowProdWrites);
    const credentials = requireCredentials(adapter);

    logger.info(`Checking ${adapter.baseUrl} ...`);
    await ensureAppReachable(adapter.baseUrl);
    logger.success("App is reachable.");

    const runDir = path.join(env.outputDir, adapter.id, "smoke", stamp());
    const videoDir = path.join(runDir, "video");
    const shotDir = path.join(runDir, "screenshots");
    fs.mkdirSync(shotDir, { recursive: true });
    const storageStatePath = sessionAuthPath(env.outputDir, adapter.id);

    const safety: SafetyConfig = { ...adapter.safety, readOnly: preflight.effectiveReadOnly };
    const session = await createSession({
        baseUrl: adapter.baseUrl,
        headless: env.headless,
        safety,
        videoDir,
    });

    try {
        logger.info("Logging in ...");
        const result = await loginWithDiagnostics(session, adapter, credentials, env.loginTimeoutMs, shotDir);
        logger.success(`Logged in. Landed on ${result.landedUrl}`);
        if (result.needsOrganizationSelection) {
            logger.warn("Landed on organization selection (multiple orgs). Phase 1 will handle picking one.");
        }

        fs.mkdirSync(path.dirname(storageStatePath), { recursive: true });
        await session.context.storageState({ path: storageStatePath });
        logger.info(`Saved session -> ${storageStatePath}`);

        // Let the page settle so the screenshot captures content, not a loading spinner.
        await session.page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
        const shot = path.join(shotDir, "landing.png");
        await session.page.screenshot({ path: shot, fullPage: true });
        logger.info(`Screenshot -> ${shot}`);
    } finally {
        // Teardown must never mask a body error or skip the blocked-write report.
        const videoPath = await closeQuietly(session.close);
        if (videoPath) {
            logger.info(`Video -> ${videoPath}`);
        }
        reportBlocked(session.blocked);
    }

    logger.success(`Smoke complete. Artifacts in ${runDir}`);
}

/**
 * Phase 1: log in, then autonomously crawl the app into an interaction graph and
 * persist it. Read-only and bounded by maxPages so it always terminates.
 */
export async function runCrawl(maxPages: number, interact: boolean, actuationsPerPage: number): Promise<void> {
    logger.banner(`Phase 1 crawl — mapping the app (max ${maxPages} pages)`);
    const env = loadEnvConfig();
    const adapter = getAdapter();

    const preflight = await runProductionPreflight(adapter, env.allowProdWrites);
    const credentials = requireCredentials(adapter);
    await ensureAppReachable(adapter.baseUrl);

    let reasoner: Reasoner | null = null;
    if (interact) {
        const issue = llmCredentialIssue(env.llmProvider);
        if (issue) {
            logger.warn(`Interaction off: ${issue} (provider=${env.llmProvider}). Following links only.`);
        } else {
            reasoner = createReasoner(env);
            startRun(`crawl-${maxPages}`, { kind: "crawl", model: reasoner.modelLabel });
            logger.info(`Interaction on via ${reasoner.modelLabel}.`);
        }
    }

    const safety: SafetyConfig = { ...adapter.safety, readOnly: preflight.effectiveReadOnly };
    const session = await createSession({ baseUrl: adapter.baseUrl, headless: env.headless, safety });

    let graph: InteractionGraph | null = null;
    try {
        logger.info("Authenticating ...");
        await performLogin(session.page, adapter.auth, credentials, { timeoutMs: env.loginTimeoutMs });
        logger.success("Authenticated. Crawling ...");

        graph = await crawl(session, adapter, {
            maxPages,
            settleMs: 6000,
            navTimeoutMs: env.loginTimeoutMs,
            screenshot: true,
            screenshotDir: graphScreenshotDir(env.outputDir, adapter.id),
            gitSha: currentGitSha(REPO_ROOT),
            interact: reasoner !== null,
            reasoner,
            actuationsPerPage,
            pacing: pacingFromEnv(env),
        });
    } finally {
        await closeQuietly(session.close);
    }

    if (graph) {
        const { graphFile } = saveGraph(graph, env.outputDir);
        reportCoverage(graph);
        logger.success(`Interaction graph saved -> ${graphFile}`);
    }
    reportBlocked(session.blocked);
    await reportRunCost();
}

/**
 * Phase 1: turn the latest interaction graph into a human-readable Markdown site
 * map via the LLM reasoning layer. Reads the saved graph — no browsing needed.
 */
export async function runSiteMap(): Promise<void> {
    logger.banner("Phase 1 site map — synthesize a readable map from the graph");
    const env = loadEnvConfig();
    const adapter = getAdapter();

    const graphFile = path.join(env.outputDir, adapter.id, "graph", "latest.json");
    if (!fs.existsSync(graphFile)) {
        throw new Error(`No interaction graph at ${graphFile}. Run \`sentinel crawl\` first.`);
    }

    const credentialIssue = llmCredentialIssue(env.llmProvider);
    if (credentialIssue) {
        throw new Error(
            `${credentialIssue} (provider=${env.llmProvider}). Set it in apps/qa-agent/.env, ` +
                "or change SENTINEL_LLM_PROVIDER / SENTINEL_LLM_MODEL.",
        );
    }

    const graph = loadGraph(graphFile);
    logger.info(`Loaded graph: ${graph.coverage.nodeCount} pages, ${graph.coverage.edgeCount} edges.`);
    const reasoner = createReasoner(env);
    startRun("sitemap", { kind: "sitemap", model: reasoner.modelLabel });
    logger.info(`Synthesizing with ${reasoner.modelLabel} ...`);

    const markdown = await synthesizeSiteMap(graph, reasoner);
    const outFile = path.join(env.outputDir, adapter.id, "site-map.md");
    fs.writeFileSync(outFile, markdown);
    logger.success(`Site map written -> ${outFile}`);
    await reportRunCost();
}

function reportCoverage(graph: InteractionGraph): void {
    const c = graph.coverage;
    logger.success(`Mapped ${c.nodeCount} page state(s), ${c.edgeCount} navigation edge(s).`);
    logger.info(`Areas reached: ${c.areasReached.join(", ") || "(none)"}`);
    if (c.routesUnreached.length > 0) {
        logger.warn(`Seeded routes not reached: ${c.routesUnreached.join(", ")}`);
    }
    for (const note of c.notes.slice(0, 15)) {
        logger.warn(`  note: ${note}`);
    }
    if (c.notes.length > 15) {
        logger.warn(`  ... and ${c.notes.length - 15} more notes`);
    }
}

/**
 * Phase 2: replay a PR's affected flows against its web preview deployment.
 * Resolves the preview URL from GitHub, maps the diff to routes, re-walks the
 * matching baseline flows with video + console/network capture + control diffing.
 */
export async function runPr(prNumber: number, baseUrlOverride: string | null, maxFlows: number): Promise<void> {
    if (prNumber <= 0) {
        throw new Error("Provide a PR number, e.g. `sentinel pr 1356`.");
    }
    logger.banner(`Phase 2 PR replay — #${prNumber}`);
    const env = loadEnvConfig();
    const adapter = getAdapter();
    const credentials = requireCredentials(adapter);

    const meta = await getPrMeta(prNumber);
    logger.info(`PR #${meta.number}: ${meta.title}`);
    const changed = await getChangedFiles(prNumber);
    const { routes, notes } = adapter.affectedRoutes(changed);
    logger.info(`${changed.length} changed file(s). Affected routes: ${routes.join(", ") || "(none — default set)"}`);
    for (const note of notes) {
        logger.warn(`  ${note}`);
    }

    let targetUrl = baseUrlOverride;
    if (!targetUrl) {
        const repo = await detectRepo();
        if (repo) {
            targetUrl = await resolveWebPreviewUrl(repo, meta.headSha, adapter.previewEnvIncludes);
        }
    }
    if (!targetUrl) {
        throw new Error(
            `Could not resolve a web preview URL for PR #${prNumber}. Pass --base-url <url> (the Vercel "web" ` +
                "preview), or check the PR has a ready 'Preview – web' deployment.",
        );
    }
    logger.info(`Target: ${targetUrl}`);

    const graphFile = path.join(env.outputDir, adapter.id, "graph", "latest.json");
    if (!fs.existsSync(graphFile)) {
        throw new Error(`No baseline interaction graph at ${graphFile}. Run \`sentinel crawl\` first.`);
    }
    const graph = loadGraph(graphFile);
    const flows = selectFlows(graph, routes, maxFlows);
    const matchesRoute = (url: string): boolean => routes.some((r) => url === r || url.startsWith(`${r}/`));
    const selectionMode: PrRunManifest["selectionMode"] =
        routes.length > 0 && flows.slice(1).some((f) => matchesRoute(f.url)) ? "affected-routes" : "default-spread";
    logger.info(`Replaying ${flows.length} flow(s) from the baseline graph (${selectionMode}).`);

    // Build a target-scoped adapter so the preflight's prod detection runs against the real preview URL.
    const preflight = await runProductionPreflight(getAdapter({ baseUrl: targetUrl }), env.allowProdWrites);
    await ensureAppReachable(targetUrl);

    const runDir = path.join(env.outputDir, adapter.id, "pr-runs", `${prNumber}-${stamp()}`);
    const screenshotDir = path.join(runDir, "screenshots");
    fs.mkdirSync(screenshotDir, { recursive: true });

    const safety: SafetyConfig = { ...adapter.safety, readOnly: preflight.effectiveReadOnly };
    const session = await createSession({
        baseUrl: targetUrl,
        headless: env.headless,
        safety,
        videoDir: path.join(runDir, "video"),
    });

    let videoPath: string | null = null;
    let flowResults: FlowResult[] = [];
    try {
        logger.info("Authenticating ...");
        await performLogin(session.page, adapter.auth, credentials, { timeoutMs: env.loginTimeoutMs });
        logger.success("Authenticated. Replaying flows ...");
        flowResults = await replayFlows(session, flows, {
            settleMs: 6000,
            navTimeoutMs: env.loginTimeoutMs,
            screenshotDir,
            destructive: adapter.safety.destructiveControlPatterns.map((p) => new RegExp(p, "i")),
            loginPath: adapter.auth.loginPath,
            pacing: pacingFromEnv(env),
        });
    } finally {
        videoPath = await closeQuietly(session.close);
    }

    const manifest = buildPrManifest(
        meta,
        changed,
        targetUrl,
        graph,
        selectionMode,
        routes,
        notes,
        flowResults,
        videoPath,
    );
    // The manifest is the artifact most likely to be shared (a PR comment) — redact before disk.
    fs.writeFileSync(path.join(runDir, "manifest.json"), redactSecret(JSON.stringify(manifest, null, 2)));
    reportPrRun(manifest, runDir);
    reportBlocked(session.blocked);
}

function buildPrManifest(
    meta: PrMeta,
    changedFiles: string[],
    targetUrl: string,
    graph: InteractionGraph,
    selectionMode: PrRunManifest["selectionMode"],
    routes: string[],
    notes: string[],
    flows: FlowResult[],
    video: string | null,
): PrRunManifest {
    return {
        pr: meta.number,
        title: meta.title,
        body: meta.body,
        headSha: meta.headSha,
        headRef: meta.headRef,
        changedFiles,
        targetUrl,
        baselineSha: graph.gitSha,
        baselineCreatedAt: graph.createdAt,
        baselineBaseUrl: graph.baseUrl,
        selectionMode,
        affectedRoutes: routes,
        notes,
        flows,
        summary: {
            flowsReplayed: flows.length,
            flowsWithConsoleErrors: flows.filter((f) => f.consoleErrors.length > 0).length,
            flowsWithNetworkErrors: flows.filter((f) => f.networkErrors.length > 0).length,
            flowsWithControlChanges: flows.filter((f) => f.controlDiff.missing.length || f.controlDiff.added.length)
                .length,
            flowsUnreached: flows.filter((f) => !f.reached).length,
            blockedWrites: flows.reduce((sum, f) => sum + f.blockedWrites, 0),
        },
        createdAt: new Date().toISOString(),
        video,
    };
}

function reportPrRun(manifest: PrRunManifest, runDir: string): void {
    const s = manifest.summary;
    logger.success(`Replayed ${s.flowsReplayed} flow(s).`);
    if (s.flowsUnreached) {
        logger.warn(`  ${s.flowsUnreached} unreached`);
    }
    if (s.flowsWithConsoleErrors) {
        logger.warn(`  ${s.flowsWithConsoleErrors} with console errors`);
    }
    if (s.flowsWithNetworkErrors) {
        logger.warn(`  ${s.flowsWithNetworkErrors} with failed network calls`);
    }
    if (s.flowsWithControlChanges) {
        logger.warn(`  ${s.flowsWithControlChanges} with control changes vs baseline`);
    }
    logger.success(`Manifest + video + screenshots in ${runDir}`);
}

/**
 * Phase 3: plan a browser test that demonstrates a PR's change, run it on the
 * preview (read-only, on camera), then judge whether the PR does what it claims.
 */
export async function runVerify(prNumber: number, baseUrlOverride: string | null, planOnly: boolean): Promise<void> {
    if (prNumber <= 0) {
        throw new Error("Provide a PR number, e.g. `sentinel verify 1356`.");
    }
    logger.banner(`Phase 3 verify — #${prNumber}${planOnly ? " (plan only)" : ""}`);
    const env = loadEnvConfig();
    const adapter = getAdapter();
    const credentials = requireCredentials(adapter);

    const issue = llmCredentialIssue(env.llmProvider);
    if (issue) {
        throw new Error(`${issue} (provider=${env.llmProvider}). Verify needs the LLM — set it in apps/qa-agent/.env.`);
    }
    const reasoner = createReasoner(env);
    startRun(`verify-${prNumber}`, { pr: prNumber, kind: "verify", model: reasoner.modelLabel });

    const meta = await getPrMeta(prNumber);
    logger.info(`PR #${meta.number}: ${meta.title}`);
    const changed = await getChangedFiles(prNumber);
    const { routes } = adapter.affectedRoutes(changed);
    logger.info(`Affected routes: ${routes.join(", ") || "(none — start at /home)"}`);

    const graphFile = path.join(env.outputDir, adapter.id, "graph", "latest.json");
    if (!fs.existsSync(graphFile)) {
        throw new Error(`No interaction graph at ${graphFile}. Run \`sentinel crawl\` first.`);
    }
    const graph = loadGraph(graphFile);

    logger.info(`Planning with ${reasoner.modelLabel} ...`);
    const diff = await getPrDiff(prNumber, 6000);
    const plan = await generatePlan(
        reasoner,
        { title: meta.title, body: meta.body, changedFiles: changed, affectedRoutes: routes, diffExcerpt: diff },
        graph,
    );
    reportPlan(plan);

    const runDir = path.join(env.outputDir, adapter.id, "verify-runs", `${prNumber}-${stamp()}`);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, "plan.json"), JSON.stringify(plan, null, 2));
    if (planOnly) {
        logger.success(`Plan written -> ${path.join(runDir, "plan.json")}`);
        await reportRunCost();
        return;
    }

    let targetUrl = baseUrlOverride;
    if (!targetUrl) {
        const repo = await detectRepo();
        if (repo) {
            targetUrl = await resolveWebPreviewUrl(repo, meta.headSha, adapter.previewEnvIncludes);
        }
    }
    if (!targetUrl) {
        throw new Error(
            `Could not resolve a web preview for PR #${prNumber}. Pass --base-url, or ensure a ready 'Preview – web' deployment.`,
        );
    }
    logger.info(`Target: ${targetUrl}`);

    const preflight = await runProductionPreflight(getAdapter({ baseUrl: targetUrl }), env.allowProdWrites);
    await ensureAppReachable(targetUrl);

    const screenshotDir = path.join(runDir, "screenshots");
    fs.mkdirSync(screenshotDir, { recursive: true });
    const safety: SafetyConfig = { ...adapter.safety, readOnly: preflight.effectiveReadOnly };
    const session = await createSession({
        baseUrl: targetUrl,
        headless: env.headless,
        safety,
        videoDir: path.join(runDir, "video"),
    });

    let videoPath: string | null = null;
    let results: StepResult[] = [];
    let verdict: Verdict = { outcome: "uncertain", confidence: "low", summary: "Not executed.", evidence: [] };
    try {
        logger.info("Authenticating ...");
        await performLogin(session.page, adapter.auth, credentials, { timeoutMs: env.loginTimeoutMs });
        logger.success("Authenticated. Executing the plan ...");
        if (plan.startRoute) {
            await session.page
                .goto(plan.startRoute, { waitUntil: "domcontentloaded", timeout: env.loginTimeoutMs })
                .catch(() => {});
        }
        results = await executePlan(session, plan, {
            reasoner,
            destructive: adapter.safety.destructiveControlPatterns.map((p) => new RegExp(p, "i")),
            settleMs: 6000,
            navTimeoutMs: env.loginTimeoutMs,
            clickTimeoutMs: 8000,
            screenshotDir,
            pacing: pacingFromEnv(env),
            loginPath: adapter.auth.loginPath,
        });
        logger.info("Judging ...");
        verdict = await judgeVerdict(reasoner, meta.title, meta.body, plan, results);
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
        changedFiles: changed,
        affectedRoutes: routes,
        readOnly: preflight.effectiveReadOnly,
        blockedWrites: session.blocked.filter((b) => b.reason === "mutation").length,
        model: reasoner.modelLabel,
        plan,
        results,
        verdict,
        video: videoPath,
        createdAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(runDir, "manifest.json"), redactSecret(JSON.stringify(manifest, null, 2)));
    reportVerify(manifest, runDir);
    reportBlocked(session.blocked);
    await reportRunCost();
}

function reportPlan(plan: TestPlan): void {
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

function reportVerify(manifest: VerifyManifest, runDir: string): void {
    const ok = manifest.results.filter((r) => r.status === "ok").length;
    const failed = manifest.results.filter((r) => r.status === "failed").length;
    const blocked = manifest.results.filter((r) => r.status === "blocked").length;
    logger.info(`Steps: ${ok} ok, ${failed} failed, ${blocked} blocked (read-only).`);
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
    logger.success(`Plan + per-step screenshots + video + manifest in ${runDir}`);
}

/** Run the login, and on failure capture a screenshot + page title/url so the failure is never a mystery. */
async function loginWithDiagnostics(
    session: DriverSession,
    adapter: RepoAdapter,
    credentials: Credentials,
    timeoutMs: number,
    shotDir: string,
): Promise<LoginResult> {
    try {
        return await performLogin(session.page, adapter.auth, credentials, { timeoutMs });
    } catch (error) {
        const failShot = path.join(shotDir, "login-failure.png");
        await session.page.screenshot({ path: failShot, fullPage: true }).catch(() => {});
        const title = await session.page.title().catch(() => "?");
        logger.error(`Login failed at ${session.page.url()} (title: "${title}").`);
        logger.error(`Diagnostic screenshot -> ${failShot}`);
        throw error;
    }
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
