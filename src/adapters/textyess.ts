import * as fs from "node:fs";
import * as path from "node:path";
import * as dotenv from "dotenv";
import type { EnvConfig } from "../core/config";
import { REPO_ROOT } from "../core/config";
import { logger } from "../core/logger";
import type { DatastoreTarget, RepoAdapter, SafetyConfig } from "../core/types";

const DEFAULT_BASE_URL = "http://localhost:3000";

/** All TextYess-specific knowledge lives here. A second repo gets its own adapter. */
const SAFETY: Omit<SafetyConfig, "readOnly"> = {
    // The ONLY mutating endpoints allowed through in read-only mode — the writes the
    // login flow performs. Anchored to the URL path (matched against pathname only)
    // so query-string smuggling and sibling routes (e.g. /auth/login-as-admin) can't
    // sneak through. Everything else mutating is aborted.
    allowedMutationPatterns: ["^/auth/login$", "^/auth/(me/)?select-organization$"],
    telemetryPatterns: [
        "posthog",
        "/ingest/",
        "sentry\\.io",
        "ingest\\.sentry",
        "nebuly",
        "hotjar",
        "google-analytics",
        "googletagmanager",
        "doubleclick",
        "facebook\\.com/tr",
        "connect\\.facebook",
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
        // Once Sentinel actuates (clicks) controls, the name denylist is a primary gate,
        // so it also covers common write / GET-side-effect verbs beyond plain deletes.
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
        "\\breindex\\b",
        "\\bactivate\\b",
        "\\bsync\\b",
        "\\bexport\\b",
        "\\bconfirm\\b",
        "\\bexit\\b",
        "end\\s*session",
    ],
    // Connection-string / host fragments that indicate production. The non-local
    // host fail-safe in the preflight is the real backstop; these add clear labels
    // and catch a local web app pointed at a prod API.
    productionMarkers: [
        "mongodb\\.net",
        "ai\\.textyess\\.com",
        "app\\.textyess\\.com",
        "DATABASE_NAME=prod",
        "/prod(\\b|/|$)",
    ],
    // The team has approved running against prod for now; instead of refusing, the
    // read-only network guard enforces safety. Flip to true once a dedicated
    // non-prod environment exists.
    failClosedOnProduction: false,
};

/**
 * Warm-start hint for the Phase 1 crawler (the live nav tree is the source of
 * truth). Cross-checked against apps/web/src/pages/. Note: /flows vs /flows2 and
 * the /agents leaves are feature-flag dependent, so both variants are listed.
 */
const KNOWN_ROUTES = [
    "/home",
    "/campaigns",
    "/flows",
    "/flows2",
    "/contacts",
    "/contact-groups",
    "/segments",
    "/inbox",
    "/agents/whatsapp",
    "/agents/onsite",
    "/agents/voice",
    "/analytics",
    "/conversation-intelligence",
    "/store-intelligence",
    "/knowledge-base",
    "/growth-tool-kit",
    "/integrations",
    "/ai-settings",
    "/organization-settings",
    "/developers",
    "/referral",
    "/video-library",
    "/atlas",
    "/admin",
];

function readEnvFile(absPath: string): Record<string, string> {
    if (!fs.existsSync(absPath)) {
        return {};
    }
    try {
        return dotenv.parse(fs.readFileSync(absPath));
    } catch {
        return {};
    }
}

const WEB_PAGES_PREFIX = "apps/web/src/pages/";

/** Map a PR's changed files to the dashboard routes worth re-walking, with caveats. */
function affectedRoutes(changedFiles: string[]): { routes: string[]; notes: string[] } {
    const routes = new Set<string>();
    const notes: string[] = [];
    let webPageChange = false;
    let webOtherChange = false;
    let nonWeb = false;
    let skippedDynamic = false;

    for (const file of changedFiles) {
        if (file.startsWith(WEB_PAGES_PREFIX)) {
            webPageChange = true;
            const segments = file
                .slice(WEB_PAGES_PREFIX.length)
                .replace(/\.(tsx?|jsx?)$/, "")
                .split("/")
                .filter(Boolean);
            // index.tsx maps to its parent path.
            if (segments[segments.length - 1] === "index") {
                segments.pop();
            }
            if (segments.length === 0) {
                routes.add("/home");
                continue;
            }
            // Map a nested dynamic page to its parent area (campaigns/[index] -> /campaigns).
            // A root-level dynamic/framework file ([id], _app) has no concrete route.
            const dynamicAt = segments.findIndex((s) => s.startsWith("[") || s.startsWith("_"));
            if (dynamicAt === 0) {
                skippedDynamic = true;
                continue;
            }
            const literal = dynamicAt === -1 ? segments : segments.slice(0, dynamicAt);
            routes.add(literal[0] === "home" ? "/home" : `/${literal.join("/")}`);
        } else if (file.startsWith("apps/web/")) {
            webOtherChange = true;
        } else {
            nonWeb = true;
        }
    }

    if (skippedDynamic) {
        notes.push("A changed page is dynamic/framework-level ([id]/_app) with no static route — verify manually.");
    }
    if (webOtherChange && routes.size === 0) {
        notes.push(
            "Web changes are outside pages/ (components/layout/etc.) — broad UI impact; replaying a default set.",
        );
    } else if (webOtherChange) {
        notes.push("Also changed shared web code — impact may extend beyond the listed routes.");
    }
    if (nonWeb && !webPageChange && !webOtherChange) {
        notes.push("No web changes detected (api/packages only) — the web preview won't reflect this PR.");
    } else if (nonWeb) {
        notes.push("Also changed non-web code (api/packages) — the web preview won't reflect backend changes.");
    }
    return { routes: Array.from(routes), notes };
}

export function createTextyessAdapter(env: EnvConfig): RepoAdapter {
    const baseUrl = env.baseUrl ?? DEFAULT_BASE_URL;
    const safety: SafetyConfig = { readOnly: env.readOnly, ...SAFETY };

    return {
        id: "textyess",
        displayName: "TextYess Dashboard",
        baseUrl,
        ports: { web: 3000, api: 8088, worker: 8090, brain0: 8080, gateway: 8098 },
        auth: {
            loginPath: "/login",
            emailLabel: "Email",
            passwordLabel: "Password",
            submitNamePattern: "log\\s*in",
            // Anchored to a path-segment boundary so /settings/home-page can't masquerade as a landing.
            authenticatedUrlPattern: "/(home|dashboard|organizations|onboarding)(/|\\?|#|$)",
            // Fallbacks in case the label association changes; the login form uses typed inputs.
            emailFallbackSelector: 'input[type="email"]',
            passwordFallbackSelector: 'input[type="password"]',
            publicRoutes: [
                "/login",
                "/signup",
                "/recover-password",
                "/reset-password",
                "/confirm-account",
                "/confirm-email",
                "/email-verified",
                "/privacy-policy",
                "/cookie-policy-v1",
                "/invitations/accept",
            ],
        },
        safety,
        knownRoutes: KNOWN_ROUTES,
        previewEnvIncludes: "web",
        affectedRoutes,
        credentials: env.email && env.password ? { email: env.email, password: env.password } : null,
        async resolveDatastoreTargets(): Promise<DatastoreTarget[]> {
            const apiEnv = readEnvFile(path.join(REPO_ROOT, "apps", "api", ".env"));
            const brain0Env = readEnvFile(path.join(REPO_ROOT, "apps", "brain0", ".env"));
            const webEnv = readEnvFile(path.join(REPO_ROOT, "apps", "web", ".env"));
            const targets: DatastoreTarget[] = [];

            // The API origin the browser actually POSTs to — the destination that matters most.
            if (webEnv.NEXT_PUBLIC_BASE_URL) {
                targets.push({
                    label: "apps/web NEXT_PUBLIC_BASE_URL (browser API origin)",
                    source: "apps/web/.env",
                    value: webEnv.NEXT_PUBLIC_BASE_URL,
                });
            }
            if (apiEnv.DB_SERVER) {
                targets.push({ label: "apps/api DB_SERVER", source: "apps/api/.env", value: apiEnv.DB_SERVER });
            }
            if (brain0Env.MONGODB_URL) {
                targets.push({
                    label: "apps/brain0 MONGODB_URL",
                    source: "apps/brain0/.env",
                    value: brain0Env.MONGODB_URL,
                });
            }
            if (brain0Env.DATABASE_URL) {
                targets.push({
                    label: "apps/brain0 DATABASE_URL",
                    source: "apps/brain0/.env",
                    value: brain0Env.DATABASE_URL,
                });
            }
            if (brain0Env.NESTJS_API_URL) {
                targets.push({
                    label: "apps/brain0 NESTJS_API_URL",
                    source: "apps/brain0/.env",
                    value: brain0Env.NESTJS_API_URL,
                });
            }

            // The web origin Sentinel drives (also covered by the remote-host fail-safe).
            targets.push({ label: "Sentinel target URL", source: "SENTINEL_BASE_URL", value: baseUrl });

            if (Object.keys(apiEnv).length === 0 && Object.keys(brain0Env).length === 0) {
                logger.warn(
                    "Could not read apps/api/.env or apps/brain0/.env — production detection relies on the target URL only.",
                );
            }
            return targets;
        },
    };
}
