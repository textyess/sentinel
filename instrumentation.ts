// Next runs register() once per server runtime on boot. The actual node-only work
// (the engine import + the mention poller) lives in a separate module imported ONLY
// under the nodejs guard, so the edge compilation of instrumentation never pulls in
// Playwright (whose native fsevents.node is not bundleable for non-node targets).
export async function register(): Promise<void> {
    if (process.env.NEXT_RUNTIME === "nodejs") {
        await import("./instrumentation-node");
    }
}
