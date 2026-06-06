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
        // PORT (injected by hosts like Railway) wins, matching the `start` script's
        // bind precedence, so dashboardUrl()'s fallback reports the port we actually
        // listen on; then SENTINEL_UI_PORT, then the default.
        port: numEnv(process.env.PORT ?? process.env.SENTINEL_UI_PORT, 4317),
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

export function dashboardUrl(): string {
    // A hosted deploy can advertise its real dashboard URL (used for the "view run"
    // link in PR comments); without it, fall back to the localhost address the
    // operator reaches it on.
    const configured = process.env.SENTINEL_DASHBOARD_URL?.trim();
    if (configured) {
        return configured.replace(/\/+$/, "");
    }
    return `http://127.0.0.1:${loadServerConfig().port}`;
}
