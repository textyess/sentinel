import { performLogin } from "../auth/login";
import { ensureAppReachable } from "../bringup/app";
import { createSession } from "../browser/driver";
import type { EnvConfig } from "../config";
import { graphScreenshotDir, saveGraph } from "../graph/store";
import type { CoverageReport } from "../graph/types";
import type { PacingOptions } from "../human/pacing";
import { logger } from "../logger";
import type { Reasoner } from "../reasoner/types";
import { runProductionPreflight } from "../safety/production-guard";
import type { BlockedRequest, RepoAdapter } from "../types";
import { crawl } from "./crawler";

function pacingFromEnv(env: EnvConfig): PacingOptions {
    return { enabled: env.humanPacing, baseThinkMs: env.paceMs, maxDwellMs: env.maxDwellMs };
}

async function closeQuietly(close: () => Promise<{ videoPath: string | null }>): Promise<void> {
    try {
        await close();
    } catch (error) {
        logger.warn(`teardown: ${error instanceof Error ? error.message : String(error)}`);
    }
}

export interface RunCrawlArgs {
    /** Adapter already scoped to the baseline URL; NEVER resolved via getAdapter(). */
    adapter: RepoAdapter;
    env: EnvConfig;
    outputDir: string;
    maxPages: number;
    actuationsPerPage: number;
    /** Null disables LLM-guided actuation (link-only crawl). */
    reasoner: Reasoner | null;
    gitSha: string | null;
}

export interface RunCrawlResult {
    graphFile: string;
    coverage: CoverageReport;
    blocked: BlockedRequest[];
}

/**
 * Programmatic baseline crawl — mirrors {@link runVerifyForProject}. Maps the app
 * at adapter.baseUrl into an interaction graph and persists it. Crawl is ALWAYS
 * read-only: it has no allowProdWrites parameter, the production preflight runs
 * with writes disabled, and the crawler never follows destructive controls.
 */
export async function runCrawlForProject(args: RunCrawlArgs): Promise<RunCrawlResult> {
    const { adapter, env, outputDir, maxPages, actuationsPerPage, reasoner, gitSha } = args;

    const credentials = adapter.credentials;
    if (!credentials) {
        throw new Error(`No login configured for ${adapter.displayName} — set the project's credential env vars.`);
    }

    // Crawl never writes: literal false, no parameter to flip it.
    const preflight = await runProductionPreflight(adapter, false);
    await ensureAppReachable(adapter.baseUrl);

    const safety = { ...adapter.safety, readOnly: preflight.effectiveReadOnly };
    const session = await createSession({ baseUrl: adapter.baseUrl, headless: env.headless, safety });

    try {
        logger.info("Authenticating ...");
        await performLogin(session.page, adapter.auth, credentials, { timeoutMs: env.loginTimeoutMs });
        logger.success("Authenticated. Crawling ...");
        const graph = await crawl(session, adapter, {
            maxPages,
            settleMs: 6000,
            navTimeoutMs: env.loginTimeoutMs,
            screenshot: true,
            screenshotDir: graphScreenshotDir(outputDir, adapter.id),
            gitSha,
            interact: reasoner !== null,
            reasoner,
            actuationsPerPage,
            pacing: pacingFromEnv(env),
        });
        const { graphFile } = saveGraph(graph, outputDir);
        logger.success(
            `Mapped ${graph.coverage.nodeCount} page state(s), ${graph.coverage.edgeCount} navigation edge(s).`,
        );
        return { graphFile, coverage: graph.coverage, blocked: session.blocked };
    } finally {
        await closeQuietly(session.close);
    }
}
