import type { AuthStrategy, DatastoreTarget, RegExpSource, RepoAdapter, SafetyConfig } from "../core/types";

/**
 * A repo-agnostic adapter for ANY web app exposed at a (preview) URL. Unlike a
 * built-in adapter it reads NO local files and knows NO app-specific strings — all
 * of those come from the project's registration config. The production preflight's
 * remote-host fail-safe clamps every non-local target (e.g. *.vercel.app) to
 * read-only with zero extra code here.
 */

/** Auth recipe for a generic app, mirroring {@link AuthStrategy} but supplied at registration time. */
export interface GenericAuthConfig {
    loginPath: string;
    emailLabel: string;
    passwordLabel: string;
    submitNamePattern: RegExpSource;
    authenticatedUrlPattern: RegExpSource;
    emailFallbackSelector?: string;
    passwordFallbackSelector?: string;
    publicRoutes: string[];
}

export interface GenericProjectConfig {
    auth: GenericAuthConfig;
    /** Names of the env vars holding the test credentials — never the raw secrets. */
    emailEnv: string;
    passwordEnv: string;
    /** Substring identifying the web app's preview deployment environment (e.g. "web"). */
    previewEnvIncludes: string;
    /** Route-file prefix used to map a PR's changed files to routes (e.g. "app/" or "src/pages/"). */
    pagesPrefix?: string;
    /** Optional seed routes to accelerate any future crawl. */
    knownRoutes?: string[];
    /** Mutating requests allowed through in read-only mode — auth only. */
    allowedMutationPatterns: RegExpSource[];
    /** Optional production markers; the remote-host fail-safe is the real backstop. */
    productionMarkers?: RegExpSource[];
    /** Optional override of the destructive-control denylist. */
    destructiveControlPatterns?: RegExpSource[];
}

/**
 * Safe, app-agnostic defaults. Defined HERE (never imported from a per-repo
 * adapter) so core stays repo-agnostic and a generic project needs zero tuning.
 */
export const GENERIC_SAFETY_DEFAULTS: Omit<SafetyConfig, "readOnly" | "allowedMutationPatterns"> = {
    telemetryPatterns: [
        "posthog",
        "/ingest/",
        "sentry\\.io",
        "ingest\\.sentry",
        "hotjar",
        "google-analytics",
        "googletagmanager",
        "doubleclick",
        "facebook\\.com/tr",
        "connect\\.facebook",
        "segment\\.io",
        "amplitude",
        "mixpanel",
    ],
    destructiveControlPatterns: [
        "\\bdelete\\b",
        "\\bremove\\b",
        "\\bsend\\b",
        "\\barchive\\b",
        "\\bdeactivate\\b",
        "\\bdisconnect\\b",
        "\\buninstall\\b",
        "\\bpay\\b",
        "\\bcharge\\b",
        "\\bpublish\\b",
        "\\bdiscard\\b",
        "\\bdestroy\\b",
        "\\blog\\s*out\\b",
        "\\bsign\\s*out\\b",
        "\\bunsubscribe\\b",
        "\\brevoke\\b",
        "\\bterminate\\b",
        "\\brefund\\b",
        "\\bwipe\\b",
        "\\bpurge\\b",
        "\\breset\\b",
        "\\bcancel\\b",
        "\\bgenerate\\b",
        "\\bregenerate\\b",
        "\\bimpersonate\\b",
        "\\bactivate\\b",
        "\\bsync\\b",
        "\\bexport\\b",
        "\\bconfirm\\b",
        "\\bexit\\b",
        "end\\s*session",
    ],
    // The remote-host fail-safe clamps non-local targets to read-only on its own,
    // so a generic project needs no markers to be safe.
    productionMarkers: [],
    failClosedOnProduction: false,
};

/** Map a PR's changed files to affected routes using a configurable pages prefix. */
function genericAffectedRoutes(
    changedFiles: string[],
    pagesPrefix: string | undefined,
): { routes: string[]; notes: string[] } {
    const notes: string[] = ["Generic route mapping — coverage may be approximate."];
    if (!pagesPrefix) {
        return {
            routes: [],
            notes: ["No pages prefix configured — cannot map changes to routes; verifying a default set.", ...notes],
        };
    }

    const routes = new Set<string>();
    let pageChange = false;
    let otherChange = false;
    let skippedDynamic = false;

    for (const file of changedFiles) {
        if (!file.startsWith(pagesPrefix)) {
            otherChange = true;
            continue;
        }
        pageChange = true;
        const segments = file
            .slice(pagesPrefix.length)
            .replace(/\.(tsx?|jsx?)$/, "")
            .split("/")
            .filter(Boolean);
        if (segments[segments.length - 1] === "index") {
            segments.pop();
        }
        if (segments.length === 0) {
            routes.add("/");
            continue;
        }
        // A leading dynamic/framework segment ([id], _app, (group)) has no concrete route.
        const dynamicAt = segments.findIndex((s) => s.startsWith("[") || s.startsWith("_") || s.startsWith("("));
        if (dynamicAt === 0) {
            skippedDynamic = true;
            continue;
        }
        const literal = dynamicAt === -1 ? segments : segments.slice(0, dynamicAt);
        routes.add(`/${literal.join("/")}`);
    }

    if (skippedDynamic) {
        notes.unshift("A changed page is dynamic/framework-level with no static route — verify manually.");
    }
    if (otherChange && routes.size === 0) {
        notes.unshift("Changes are outside the pages prefix — broad UI impact; replaying a default set.");
    }
    if (!pageChange && !otherChange) {
        notes.unshift("No changed files mapped to routes.");
    }
    return { routes: Array.from(routes), notes };
}

/**
 * Build a full {@link RepoAdapter} for a registered project. `overrides.baseUrl`
 * is the resolved preview URL for a given run (registration stores no URL — the
 * URL is always the PR's preview deployment).
 */
export function createGenericAdapter(
    id: string,
    repo: string,
    config: GenericProjectConfig,
    overrides?: { baseUrl?: string },
): RepoAdapter {
    const baseUrl = overrides?.baseUrl ?? "";
    const auth: AuthStrategy = { ...config.auth };
    const safety: SafetyConfig = {
        readOnly: true,
        allowedMutationPatterns: config.allowedMutationPatterns,
        telemetryPatterns: GENERIC_SAFETY_DEFAULTS.telemetryPatterns,
        destructiveControlPatterns:
            config.destructiveControlPatterns ?? GENERIC_SAFETY_DEFAULTS.destructiveControlPatterns,
        productionMarkers: config.productionMarkers ?? GENERIC_SAFETY_DEFAULTS.productionMarkers,
        failClosedOnProduction: GENERIC_SAFETY_DEFAULTS.failClosedOnProduction,
    };
    const email = process.env[config.emailEnv];
    const password = process.env[config.passwordEnv];

    return {
        id,
        displayName: repo,
        baseUrl,
        ports: { web: 443 },
        auth,
        safety,
        knownRoutes: config.knownRoutes ?? [],
        previewEnvIncludes: config.previewEnvIncludes,
        credentials: email && password ? { email, password } : null,
        affectedRoutes(changedFiles: string[]): { routes: string[]; notes: string[] } {
            return genericAffectedRoutes(changedFiles, config.pagesPrefix);
        },
        async resolveDatastoreTargets(): Promise<DatastoreTarget[]> {
            // No local .env reads, no REPO_ROOT — the only datastore signal is the
            // target URL itself (the remote-host fail-safe handles the rest).
            return [{ label: "target preview URL", source: "project config", value: baseUrl }];
        },
    };
}
