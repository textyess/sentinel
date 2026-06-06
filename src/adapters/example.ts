import type { EnvConfig } from "../core/config";
import type { DatastoreTarget, RepoAdapter, SafetyConfig } from "../core/types";
import { GENERIC_SAFETY_DEFAULTS } from "./generic";

/**
 * Reference built-in adapter — a copy-paste starting point for adding a
 * first-party app whose knowledge is fixed in code (rather than entered in the
 * dashboard as a generic project).
 *
 * To use it, register it from a private overlay (see builtins.ts):
 *
 *   register("example", (env, overrides) =>
 *       createExampleAdapter(overrides?.baseUrl ? { ...env, baseUrl: overrides.baseUrl } : env));
 *
 * Everything app-specific lives here; the engine depends only on {@link RepoAdapter}.
 */
const DEFAULT_BASE_URL = "http://localhost:3000";

export function createExampleAdapter(env: EnvConfig): RepoAdapter {
    const baseUrl = env.baseUrl ?? DEFAULT_BASE_URL;
    const safety: SafetyConfig = {
        readOnly: env.readOnly,
        // Auth-only writes allowed through the read-only guard — anchored to the path.
        allowedMutationPatterns: ["^/login$"],
        telemetryPatterns: GENERIC_SAFETY_DEFAULTS.telemetryPatterns,
        destructiveControlPatterns: GENERIC_SAFETY_DEFAULTS.destructiveControlPatterns,
        // The remote-host fail-safe clamps non-local targets to read-only on its own;
        // add host/connection-string fragments here to label your own prod datastores.
        productionMarkers: [],
        failClosedOnProduction: false,
    };

    return {
        id: "example",
        displayName: "Example App",
        baseUrl,
        ports: { web: 3000 },
        auth: {
            loginPath: "/login",
            emailLabel: "Email",
            passwordLabel: "Password",
            submitNamePattern: "log\\s*in",
            authenticatedUrlPattern: "/(home|dashboard)(/|\\?|#|$)",
            emailFallbackSelector: 'input[type="email"]',
            passwordFallbackSelector: 'input[type="password"]',
            publicRoutes: ["/login", "/signup", "/reset-password"],
        },
        safety,
        knownRoutes: ["/home", "/settings"],
        previewEnvIncludes: "web",
        credentials: env.email && env.password ? { email: env.email, password: env.password } : null,
        affectedRoutes(changedFiles: string[]): { routes: string[]; notes: string[] } {
            // Map your framework's page files to routes here; this stub replays a default set.
            const touched = changedFiles.length > 0;
            return {
                routes: [],
                notes: [
                    touched ? "Example adapter: no route mapping configured — replaying a default set." : "No changes.",
                ],
            };
        },
        async resolveDatastoreTargets(): Promise<DatastoreTarget[]> {
            // The target URL is the only datastore signal a remote-only app exposes.
            return [{ label: "target URL", source: "example adapter", value: baseUrl }];
        },
    };
}
