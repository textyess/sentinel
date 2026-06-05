import type { ServerConfig } from "./types";

function numEnv(value: string | undefined, fallback: number): number {
    if (!value) {
        return fallback;
    }
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function loadServerConfig(): ServerConfig {
    return {
        port: numEnv(process.env.SENTINEL_UI_PORT, 4317),
        pollMs: numEnv(process.env.SENTINEL_POLL_MS, 30000),
        // MAX_CONCURRENT=1 is a hard invariant for M1: the Langfuse trace/cost state
        // is process-global, so concurrent runs would cross-contaminate it.
        maxConcurrent: numEnv(process.env.SENTINEL_MAX_CONCURRENT, 1),
        maxPreviewRetries: numEnv(process.env.SENTINEL_MAX_PREVIEW_RETRIES, 10),
    };
}

export function dashboardUrl(): string {
    return `http://127.0.0.1:${loadServerConfig().port}`;
}
