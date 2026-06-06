import type { DocumentNode, OperationDefinitionNode } from "graphql";
import { Kind, OperationTypeNode, parse } from "graphql";
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
 * Recognize a POST body as a GraphQL read (a `query`) rather than a write. GraphQL
 * queries are side-effect-free by spec, so they are reads that merely travel over
 * POST — the modern norm — and a read-only run can let them reach the server (the
 * only way a query-via-POST app renders anything). Returns true ONLY for GraphQL
 * whose every operation is a query; a `mutation`/`subscription`, a missing/non-string
 * `query`, a non-JSON or non-GraphQL body, or any unparseable shape returns false so
 * the caller still blocks it. A mutation is never let through.
 */
function isReadOnlyGraphQL(body: string | null | undefined): boolean {
    if (!body) {
        return false;
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(body);
    } catch {
        return false;
    }
    // A batched request is a JSON array of operations; allow it only if every one is a read.
    const operations = Array.isArray(parsed) ? parsed : [parsed];
    if (operations.length === 0) {
        return false;
    }
    return operations.every((op) => {
        if (typeof op !== "object" || op === null) {
            return false;
        }
        const record = op as Record<string, unknown>;
        // GraphQL-over-HTTP routes the operation through `query` only. Refuse a body that
        // smuggles a top-level `mutation`/`subscription` key — a non-compliant server could
        // act on it — so the verdict rests solely on the fields the spec says are executed.
        if ("mutation" in record || "subscription" in record) {
            return false;
        }
        // A missing query string (e.g. an Apollo persisted query sent as a hash only)
        // can't be classified here — the operation lives server-side and could be a
        // mutation — so it is NOT allowed. Such reads stay blocked, by design.
        const query = record.query;
        return typeof query === "string" && isQueryOnlyDocument(query);
    });
}

/**
 * True when a GraphQL document is a read: it parses, has at least one operation, and
 * EVERY operation is a `query` (never `mutation`/`subscription`). Parsed with the
 * canonical `graphql` lexer rather than text-scanned — regex stripping of strings and
 * comments is fragile (a `#`-comment quote can desync the scan and erase a real
 * keyword), and this is the write-protection boundary, so it must be exact. A document
 * that won't parse, has no operation, or carries any non-query is blocked. Erring to
 * block: a document that merely *declares* an unused mutation is blocked too, even if
 * the client would have selected a query — the safe direction for a read-only guard.
 */
function isQueryOnlyDocument(document: string): boolean {
    let parsed: DocumentNode;
    try {
        parsed = parse(document);
    } catch {
        return false;
    }
    const operations = parsed.definitions.filter(
        (def): def is OperationDefinitionNode => def.kind === Kind.OPERATION_DEFINITION,
    );
    return operations.length > 0 && operations.every((op) => op.operation === OperationTypeNode.QUERY);
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
 * - GraphQL `query` operations (reads-over-POST) are let through so query-via-POST
 *   apps render; `mutation`/`subscription` and any non-query POST body stay blocked.
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

        // GraphQL queries are reads-over-POST (side-effect-free by spec): let them reach
        // the server so a query-via-POST app can render. Mutations/subscriptions and any
        // POST body not recognizably a pure query fall through to the block below.
        if (method === "POST" && isReadOnlyGraphQL(request.postData())) {
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
