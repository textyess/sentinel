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
export async function ensureAppReachable(baseUrl: string, timeoutMs = 60000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let last: ProbeResult = { reachable: false, status: null, error: "not attempted" };

    while (Date.now() < deadline) {
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
        return { reachable: response.status > 0, status: response.status, error: null };
    } catch (error) {
        return { reachable: false, status: null, error: error instanceof Error ? error.message : String(error) };
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
