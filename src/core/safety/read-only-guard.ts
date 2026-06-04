import type { BrowserContext, Request } from "playwright";
import type { BlockedRequest, SafetyConfig } from "../types";

const SAFE_METHODS = new Set(["GET", "HEAD"]);

function pathnameOf(url: string): string {
    try {
        return new URL(url).pathname;
    } catch {
        return url;
    }
}

/**
 * CORS headers echoing the request so the browser will accept our locally-served
 * response. Without these, a cross-origin fetch we fulfill would be rejected by
 * the CORS check and surface as "Failed to fetch" — exactly the failure we are
 * trying to avoid.
 */
function corsHeaders(request: Request): Record<string, string> {
    const reqHeaders = request.headers();
    const origin = reqHeaders.origin;
    const requestedHeaders = reqHeaders["access-control-request-headers"];
    const headers: Record<string, string> = {
        "access-control-allow-methods": "GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS",
        "access-control-allow-headers": requestedHeaders ?? "Content-Type, Authorization, x-auth-token",
    };
    if (origin) {
        headers["access-control-allow-origin"] = origin;
        headers["access-control-allow-credentials"] = "true";
    } else {
        headers["access-control-allow-origin"] = "*";
    }
    return headers;
}

/**
 * Make "read-only" real instead of aspirational: intercept every request and stop
 * any mutating one (POST/PUT/PATCH/DELETE) — except a small auth allowlist —
 * before it leaves the browser. Even if the agent clicks a destructive control,
 * the write never reaches the server.
 *
 * Crucially, blocked requests are *fulfilled locally*, never network-aborted: an
 * abort makes fetch reject with "Failed to fetch", which uncaught SDKs (PostHog,
 * Sentry) turn into a blocking Next.js dev error overlay. Telemetry gets a benign
 * 200 so its SDK stays quiet (and no analytics leak out); real mutations get a
 * handled 423 so the app's normal error path runs. Neither is forwarded upstream.
 *
 * Notes:
 * - The auth allowlist is matched against the URL PATH only, so query-string
 *   smuggling (?next=/auth/login) can't slip a mutation through.
 * - CORS preflights for intercepted requests are answered locally.
 * - The handler never throws out of itself (races during teardown are swallowed).
 * - Service-worker traffic is closed off at the context level (driver sets
 *   serviceWorkers: "block"), since context.route cannot intercept it.
 */
export async function installReadOnlyGuard(
    context: BrowserContext,
    safety: SafetyConfig,
    onBlocked: (blocked: BlockedRequest) => void,
): Promise<void> {
    const allowed = safety.allowedMutationPatterns.map((p) => new RegExp(p, "i"));
    const telemetry = safety.telemetryPatterns.map((p) => new RegExp(p, "i"));

    await context.route("**/*", async (route) => {
        const request = route.request();
        const method = request.method().toUpperCase();
        const url = request.url();
        const isTelemetry = telemetry.some((re) => re.test(url));
        const isAllowedMutation = allowed.some((re) => re.test(pathnameOf(url)));

        // Answer the preflight locally when the actual request will be intercepted,
        // so the browser proceeds (and the preflight itself doesn't leak telemetry).
        if (method === "OPTIONS") {
            const requestedMethod = (request.headers()["access-control-request-method"] ?? "").toUpperCase();
            const willIntercept =
                isTelemetry || (requestedMethod !== "" && !SAFE_METHODS.has(requestedMethod) && !isAllowedMutation);
            if (willIntercept) {
                await safeResolve(() => route.fulfill({ status: 204, headers: corsHeaders(request) }));
                return;
            }
            await safeResolve(() => route.continue());
            return;
        }

        if (isTelemetry) {
            onBlocked({ method, url, reason: "telemetry", at: new Date().toISOString() });
            await safeResolve(() =>
                route.fulfill({
                    status: 200,
                    headers: { ...corsHeaders(request), "content-type": "application/json" },
                    body: "{}",
                }),
            );
            return;
        }

        if (SAFE_METHODS.has(method)) {
            await safeResolve(() => route.continue());
            return;
        }

        if (isAllowedMutation) {
            await safeResolve(() => route.continue());
            return;
        }

        onBlocked({ method, url, reason: "mutation", at: new Date().toISOString() });
        await safeResolve(() =>
            route.fulfill({
                status: 423,
                headers: { ...corsHeaders(request), "content-type": "application/json" },
                body: JSON.stringify({ error: "Blocked by Sentinel read-only guard" }),
            }),
        );
    });
}

async function safeResolve(action: () => Promise<void>): Promise<void> {
    try {
        await action();
    } catch {
        // The request was already handled, or the context is closing — nothing to do.
    }
}
