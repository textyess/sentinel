// Side-effect import: registers all first-party built-in adapters before any
// resolution happens. Keep this first so the registry is populated on load.
import "./builtins";
import { loadEnvConfig } from "../core/config";
import type { RepoAdapter } from "../core/types";
import { adapterKinds, builtinAdapterFactory, GENERIC_KIND } from "./registry";

/**
 * Resolve the default adapter for the standalone CLI. Picks the built-in named
 * by SENTINEL_ADAPTER, or the sole registered built-in when there's exactly one.
 * (The dashboard never calls this — it resolves a per-project adapter via
 * {@link adapterForProject}.)
 */
export function getAdapter(overrides?: { baseUrl?: string }): RepoAdapter {
    const env = loadEnvConfig();
    const builtins = adapterKinds().filter((k) => k !== GENERIC_KIND);
    const requested = process.env.SENTINEL_ADAPTER;
    const kind = requested ?? (builtins.length === 1 ? builtins[0] : undefined);
    if (!kind) {
        throw new Error(
            builtins.length === 0
                ? "The CLI needs a built-in adapter, but none is registered. Register one in src/adapters/builtins.ts, or use the dashboard with a generic project."
                : `Several built-in adapters are registered (${builtins.join(", ")}); set SENTINEL_ADAPTER to pick one.`,
        );
    }
    const factory = builtinAdapterFactory(kind);
    if (!factory) {
        throw new Error(`Unknown adapter '${kind}'. Registered built-ins: ${builtins.join(", ") || "(none)"}.`);
    }
    return factory(env, overrides);
}

export { adapterForProject, adapterKinds, isAdapterKind, registerBuiltinAdapter } from "./registry";
