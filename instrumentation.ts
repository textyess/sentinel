// Next calls register() once when the server process boots. This is where the
// mention poller starts — Node runtime only, never during a build or an edge context.
export async function register(): Promise<void> {
    if (process.env.NEXT_RUNTIME !== "nodejs") {
        return;
    }
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { loadEnvConfig } = await import("@/src/index");
    const { startPoller } = await import("@/src/server/poller");

    const env = loadEnvConfig();
    fs.mkdirSync(path.join(env.outputDir, "server"), { recursive: true });
    startPoller();
}
