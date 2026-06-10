import { logger } from "../logger";

interface ProbeResult {
    reachable: boolean;
    status: number | null;
    error: string | null;
}

/**
 * Block until the app under test answers HTTP, or fail with actionable guidance.
 * Any HTTP response — even a redirect to /login — means the server is up. For
 * "work in prod" this is usually instant (a running dev stack or a deployment);
 * a full local PR bring-up will hang here until the stack is healthy.
 */
export async function ensureAppReachable(
    baseUrl: string,
    timeoutMs = 60000,
    shouldAbort?: () => string | null,
): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let last: ProbeResult = { reachable: false, status: null, error: "not attempted" };

    while (Date.now() < deadline) {
        // Fail fast when the caller knows waiting is pointless (e.g. a locally-started
        // app process has already crashed) instead of burning the full timeout.
        const abort = shouldAbort?.();
        if (abort) {
            throw new Error(`App at ${baseUrl} stopped before it became reachable: ${abort}`);
        }
        last = await probe(baseUrl);
        if (last.reachable) {
            return;
        }
        logger.debug(`App not ready yet (${last.status ?? last.error}); retrying...`);
        await sleep(2000);
    }

    throw new Error(
        `App at ${baseUrl} is not reachable (${last.status ?? last.error}). ` +
            "Start it first — e.g. `pnpm dev:app` for the local stack — or point " +
            "SENTINEL_BASE_URL at a running deployment.",
    );
}

async function probe(baseUrl: string): Promise<ProbeResult> {
    try {
        const response = await fetch(baseUrl, { redirect: "manual" });
        // A returned Response always carries a real status (100-599), so ">0" accepted
        // everything — including a 500 from a server whose listener is up but whose backing
        // services are broken (e.g. a self-hosted app missing a declared secret). Require
        // non-5xx so a half-started stack fails bring-up rather than yielding a verdict against
        // an error state; 2xx/3xx/4xx (incl. a login redirect or 401) still mean it's serving.
        // ensureAppReachable keeps retrying, so a transient 5xx during cold-start still recovers.
        return { reachable: response.status < 500, status: response.status, error: null };
    } catch (error) {
        return { reachable: false, status: null, error: error instanceof Error ? error.message : String(error) };
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
