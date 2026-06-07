import * as fs from "node:fs";
import * as path from "node:path";
import { getAdapter } from "./adapters";
import type { LoginResult } from "./core/auth/login";
import { performLogin } from "./core/auth/login";
import { ensureAppReachable } from "./core/bringup/app";
import type { DriverSession } from "./core/browser/driver";
import { createSession } from "./core/browser/driver";
import { loadEnvConfig, REPO_ROOT } from "./core/config";
import { runCrawlForProject } from "./core/crawler/run";
import { currentGitSha, loadGraph } from "./core/graph/store";
import type { CoverageReport, InteractionGraph } from "./core/graph/types";
import type { PacingOptions } from "./core/human/pacing";
import { logger } from "./core/logger";
import { endRun, runTotals, startRun } from "./core/observability/langfuse";
import type { PrMeta } from "./core/pr/github";
import { detectRepo, getChangedFiles, getPrMeta, resolveWebPreviewUrl } from "./core/pr/github";
import { replayFlows, selectFlows } from "./core/pr/replay";
import type { FlowResult, PrRunManifest } from "./core/pr/types";
import { createReasoner, llmCredentialIssue } from "./core/reasoner/ai-sdk-reasoner";
import type { Reasoner } from "./core/reasoner/types";
import { runProductionPreflight } from "./core/safety/production-guard";
import { redactSecret } from "./core/safety/redact";
import { synthesizeSiteMap } from "./core/sitemap/synthesize";
import { exportSkillPack } from "./core/skills/export";
import { generateSkillPack } from "./core/skills/generate";
import { importSkillPack } from "./core/skills/import";
import { type DriftSignal, reconcileSkillPack } from "./core/skills/reconcile";
import type { BlockedRequest, Credentials, RepoAdapter, SafetyConfig } from "./core/types";
import { planForProject, runVerifyForProject } from "./core/verify/run";

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
    requireCredentials(adapter);

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

    const result = await runCrawlForProject({
        adapter,
        env,
        outputDir: env.outputDir,
        maxPages,
        actuationsPerPage,
        reasoner,
        gitSha: currentGitSha(REPO_ROOT),
    });
    logger.success(`Interaction graph saved -> ${result.graphFile}`);
    reportCoverage(result.coverage);
    reportBlocked(result.blocked);
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

/**
 * Phase 1: project the latest interaction graph into a navigation skill pack — one
 * general "how this app works" skill plus one per route area, each a loadable
 * SKILL.md. Reads the saved graph (no browsing). Every skill body is LLM-authored
 * from the observed data and verified against the graph, so the LLM is required.
 */
export async function runSkills(): Promise<void> {
    logger.banner("Phase 1 skills — author a navigation skill pack from the graph");
    const env = loadEnvConfig();
    const adapter = getAdapter();

    const graphFile = path.join(env.outputDir, adapter.id, "graph", "latest.json");
    if (!fs.existsSync(graphFile)) {
        throw new Error(`No interaction graph at ${graphFile}. Run \`sentinel crawl\` first.`);
    }
    const graph = loadGraph(graphFile);
    logger.info(`Loaded graph: ${graph.coverage.nodeCount} pages, ${graph.coverage.edgeCount} edges.`);

    const credentialIssue = llmCredentialIssue(env.llmProvider);
    if (credentialIssue) {
        throw new Error(
            `${credentialIssue} (provider=${env.llmProvider}). Skill authoring needs the LLM — set it in ` +
                "apps/qa-agent/.env, or change SENTINEL_LLM_PROVIDER / SENTINEL_LLM_MODEL.",
        );
    }
    const reasoner = createReasoner(env);
    startRun("skills", { kind: "skills", model: reasoner.modelLabel });
    logger.info(`Authoring skills with ${reasoner.modelLabel} ...`);

    const pack = await generateSkillPack({ graph, outputDir: env.outputDir, adapterId: adapter.id, reasoner });
    logger.success(`Skill pack written -> ${pack.dir} (${pack.skillCount} skill(s)).`);
    for (const area of pack.manifest.areas) {
        logger.info(`  ${area.slug}: ${area.routes.length} route(s)`);
    }
    await reportRunCost();
}

/**
 * Phase E: reconcile/promote the skill pack — the ONLY path besides `sentinel skills`
 * that rewrites skills/, and it does so by re-deriving from a fresh, read-only BASELINE
 * crawl, never from a preview. An optional verify-run `skill-proposals.json` is used only
 * as a drift report and a safety gate (reconcile refuses if its source URL is the crawl
 * target); its contents are never copied into a skill. You running this is the human gate.
 */
export async function runSkillsPromote(
    proposalsPath: string | null,
    maxPages: number,
    actuationsPerPage: number,
): Promise<void> {
    logger.banner("Phase E skills — reconcile/promote from a fresh baseline crawl");
    const env = loadEnvConfig();
    const adapter = getAdapter();
    requireCredentials(adapter);

    const credentialIssue = llmCredentialIssue(env.llmProvider);
    if (credentialIssue) {
        throw new Error(
            `${credentialIssue} (provider=${env.llmProvider}). Reconcile re-authors skills and needs the LLM — ` +
                "set it in apps/qa-agent/.env, or change SENTINEL_LLM_PROVIDER / SENTINEL_LLM_MODEL.",
        );
    }

    let drift: DriftSignal | null = null;
    if (proposalsPath) {
        if (!fs.existsSync(proposalsPath)) {
            throw new Error(`No proposals file at ${proposalsPath}.`);
        }
        const parsed = JSON.parse(fs.readFileSync(proposalsPath, "utf8")) as Partial<DriftSignal>;
        // Validate the shape before it feeds the safety gate — a malformed file must fail
        // with a clear error, never crash opaquely or hand previewSourceRefusal a bad URL.
        if (typeof parsed.targetUrl !== "string" || !Array.isArray(parsed.proposals)) {
            throw new Error(
                `${proposalsPath} is not a valid skill-proposals.json (need a "targetUrl" string and a "proposals" array).`,
            );
        }
        drift = { targetUrl: parsed.targetUrl, proposals: parsed.proposals };
        logger.warn(
            `Drift signal: ${drift.proposals.length} proposal(s) recorded against ${drift.targetUrl} ` +
                "(used as a gate + report only — never copied into skills/).",
        );
    }

    logger.info(`Re-crawling the BASELINE read-only: ${adapter.baseUrl} ...`);
    const reasoner = createReasoner(env);
    startRun("skills-promote", { kind: "skills", model: reasoner.modelLabel });

    const result = await reconcileSkillPack({
        adapter,
        env,
        outputDir: env.outputDir,
        maxPages,
        actuationsPerPage,
        reasoner,
        gitSha: currentGitSha(REPO_ROOT),
        drift,
    });
    logger.success(
        `Reconciled skill pack -> ${result.pack.dir} (${result.pack.skillCount} skill(s)) from a fresh baseline crawl.`,
    );
    if (result.driftedRoutes.length > 0) {
        logger.info(`Drift had been reported on: ${result.driftedRoutes.join(", ")}`);
    }
    await reportRunCost();
}

/**
 * Phase 1: export a portable copy of the skill pack for another agent — the internal
 * selector appendix is stripped and the safety note rewritten for a runtime without
 * Sentinel's guards. The per-skill folders drop straight into a `.claude/skills/` dir.
 */
export async function runSkillsExport(outDir: string | null): Promise<void> {
    logger.banner("Phase 1 skills — export a portable skill pack");
    const env = loadEnvConfig();
    const adapter = getAdapter();
    const dest = outDir ?? path.join(env.outputDir, adapter.id, "skills-export");
    const result = exportSkillPack({ outputDir: env.outputDir, adapterId: adapter.id, outDir: dest });
    logger.success(`Exported ${result.skillCount} portable skill(s) -> ${result.dir}`);
    logger.info("Drop these folders into another agent's `.claude/skills/`, or zip the directory to share.");
}

/**
 * Phase 1: import a shared navigation skill pack so Phase 3 verify can load it.
 * Imports are descriptive only — capability frontmatter is dropped and no bundled
 * scripts are copied; the safety guards remain the sole authority regardless.
 */
export async function runSkillsImport(sourceDir: string, overwrite: boolean): Promise<void> {
    logger.banner("Phase 1 skills — import a navigation skill pack");
    const env = loadEnvConfig();
    const adapter = getAdapter();
    const result = importSkillPack({ outputDir: env.outputDir, adapterId: adapter.id, sourceDir, overwrite });
    logger.success(`Imported ${result.installed.length}/${result.total} skill(s) into ${adapter.id}.`);
    if (result.installed.length > 0) {
        logger.info(`  installed: ${result.installed.join(", ")}`);
    }
    if (result.skipped.length > 0) {
        logger.warn(`  skipped (already exists — pass --overwrite): ${result.skipped.join(", ")}`);
    }
    logger.info("Phase 3 verify will load these for matching routes.");
}

function reportCoverage(c: CoverageReport): void {
    // The "Mapped N page state(s)..." headline is already logged by runCrawlForProject.
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
    const repo = await detectRepo();
    const adapter = getAdapter();
    requireCredentials(adapter);

    const issue = llmCredentialIssue(env.llmProvider);
    if (issue) {
        throw new Error(`${issue} (provider=${env.llmProvider}). Verify needs the LLM — set it in apps/qa-agent/.env.`);
    }
    const reasoner = createReasoner(env);
    startRun(`verify-${prNumber}`, { pr: prNumber, kind: "verify", model: reasoner.modelLabel });

    if (planOnly) {
        const { runDir } = await planForProject({ adapter, repo, prNumber, reasoner, env, outputDir: env.outputDir });
        logger.success(`Plan written -> ${path.join(runDir, "plan.json")}`);
        await reportRunCost();
        return;
    }

    let targetUrl = baseUrlOverride;
    if (!targetUrl && repo) {
        const meta = await getPrMeta(prNumber, repo);
        targetUrl = await resolveWebPreviewUrl(repo, meta.headSha, adapter.previewEnvIncludes);
    }
    if (!targetUrl) {
        throw new Error(
            `Could not resolve a web preview for PR #${prNumber}. Pass --base-url, or ensure a ready 'Preview – web' deployment.`,
        );
    }

    // A target-scoped adapter so the preflight's prod detection runs against the real target.
    const result = await runVerifyForProject({
        adapter: getAdapter({ baseUrl: targetUrl }),
        repo,
        prNumber,
        targetUrl,
        reasoner,
        env,
        outputDir: env.outputDir,
        // CLI parity: env.allowProdWrites preserves the local-dev write path. The server always passes false.
        allowProdWrites: env.allowProdWrites,
    });
    reportBlocked(result.blocked);
    logger.success(`Plan + per-step screenshots + video + manifest in ${result.runDir}`);
    await reportRunCost();
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
