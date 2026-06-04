import { loadEnvConfig } from "../core/config";
import type { RepoAdapter } from "../core/types";
import { createTextyessAdapter } from "./textyess";

/**
 * Resolve the adapter for the current run. There is a single TextYess adapter
 * today; multi-repo support turns this into a registry keyed by repo id.
 */
export function getAdapter(overrides?: { baseUrl?: string }): RepoAdapter {
    const env = loadEnvConfig();
    return createTextyessAdapter(overrides?.baseUrl ? { ...env, baseUrl: overrides.baseUrl } : env);
}

export { createTextyessAdapter };
