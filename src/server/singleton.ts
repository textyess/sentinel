/**
 * A process-wide singleton keyed by name, anchored to globalThis.
 *
 * Next bundles instrumentation.ts and the route handlers into separate module graphs,
 * and `next dev` re-evaluates modules on HMR — both would otherwise duplicate
 * module-level state. Anchoring shared server state (the SSE hub, the run in-flight
 * sets, the poller, the file-write locks) to globalThis keeps one instance across all
 * of them within the single Node process.
 */
const KEY = "__sentinelServer__";

export function singleton<T>(name: string, create: () => T): T {
    const g = globalThis as Record<string, unknown>;
    const store = (g[KEY] ??= {}) as Record<string, unknown>;
    if (!(name in store)) {
        store[name] = create();
    }
    return store[name] as T;
}
