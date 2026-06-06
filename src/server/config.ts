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
        // On by default: recordings are published so reviewers can watch them from the
        // PR comment. Set SENTINEL_VIDEO_PUBLISH=off to keep recordings local-only.
        videoPublish: process.env.SENTINEL_VIDEO_PUBLISH === "off" ? "off" : "releases",
        videoReleaseTag: process.env.SENTINEL_VIDEO_RELEASE_TAG?.trim() || "sentinel-artifacts",
    };
}

/**
 * Base URL the dashboard is reachable at. Defaults to the local bind address, which is
 * only resolvable on the operator's machine — set SENTINEL_DASHBOARD_URL to a publicly
 * reachable origin (e.g. behind a proxy) so links posted to PRs work for reviewers too.
 */
export function dashboardUrl(): string {
    const override = process.env.SENTINEL_DASHBOARD_URL?.trim();
    if (override) {
        return override.replace(/\/+$/, "");
    }
    return `http://127.0.0.1:${loadServerConfig().port}`;
}

/** Absolute URL of a run's report page — its verdict, plan, step-by-step results, and recording. */
export function reportUrl(runId: string): string {
    return `${dashboardUrl()}/runs/${encodeURIComponent(runId)}`;
}
