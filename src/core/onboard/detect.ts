import type { Page } from "playwright";
import { z } from "zod";
import { createSession } from "../browser/driver";
import { dismissOverlays, extractControls, waitForInteractive } from "../graph/extract";
import { pathnameOf, resolveInternalPath, stripQuery } from "../graph/url";
import { logger } from "../logger";
import type { Reasoner } from "../reasoner/types";
import type { AuthStrategy, RegExpSource, SafetyConfig } from "../types";
import type { RepoScanResult } from "./repo-scan";
import type { FieldMeta, OnboardProposal } from "./types";

/** Generic (not app-specific) login-route conventions to probe when the root doesn't redirect. */
const DEFAULT_LOGIN_HINTS = [
    "/login",
    "/signin",
    "/sign-in",
    "/auth/login",
    "/users/sign_in",
    "/account/login",
    "/app/login",
    "/portal",
    "/members",
    "/access",
    "/sso",
];
const DEFAULT_AUTH_URL_PATTERN = "/(home|dashboard|app|overview|account)(/|\\?|#|$)";
/** Conservative, path-boundary-anchored test for a redirect-to-login (avoids /author etc.). */
const LOGIN_REDIRECT_RE = /(^|\/)(login|sign-?in|sign_in|auth)(\/|$)/i;
/** Broader login-ish link test — safe because each match is then PROBED for a password field. */
const LOGIN_LINK_RE = /(^|\/)(login|sign-?in|sign_in|auth|portal|members|sso|account)(\/|$)/i;

/**
 * In-page probe, passed to page.evaluate as a STRING on purpose: a function literal
 * injects a `__name` helper under tsx/esbuild that does not exist in the browser and
 * throws "__name is not defined". This only READS the DOM — it never submits anything.
 */
const FORM_PROBE = `(() => {
  const isVisible = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
  };
  const inputs = Array.from(document.querySelectorAll("input")).filter(isVisible);
  const password = inputs.find((i) => (i.getAttribute("type") || "").toLowerCase() === "password") || null;
  const form = password ? password.closest("form") : document.querySelector("form");
  const email = inputs.find((i) => {
    const t = (i.getAttribute("type") || "").toLowerCase();
    if (t === "email") return true;
    if (t === "password") return false;
    const hay = ((i.getAttribute("name") || "") + (i.getAttribute("autocomplete") || "") + (i.getAttribute("id") || "") + (i.getAttribute("placeholder") || "")).toLowerCase();
    return /email|user|login/.test(hay);
  }) || null;
  const submit = Array.from(document.querySelectorAll("button, input[type=submit]")).filter(isVisible).find((b) => {
    const hay = ((b.innerText || "") + " " + (b.value || "")).toLowerCase();
    return /log\\s*in|sign\\s*in|continue|submit|next/.test(hay);
  }) || null;
  return {
    hasPassword: !!password,
    action: form ? (form.getAttribute("action") || "") : "",
    submitText: submit ? ((submit.innerText || submit.value || "").trim().slice(0, 60)) : "",
  };
})()`;

interface FormProbe {
    hasPassword: boolean;
    action: string;
    submitText: string;
}

const LLM_SCHEMA = z.object({
    isLoginPage: z.boolean(),
    emailLabel: z.string(),
    passwordLabel: z.string(),
    submitText: z.string(),
    publicLinks: z.array(z.string()).max(20),
    authenticatedUrlGuess: z.string(),
});

export interface DetectInput {
    reasoner: Reasoner;
    baseUrl: string;
    headless: boolean;
    /** Safe building blocks passed in by the caller so core imports no app config. */
    telemetryPatterns: RegExpSource[];
    destructiveControlPatterns: RegExpSource[];
    /** Optional generic login-path candidates to probe (web conventions, not app-specific). */
    loginPathHints?: string[];
    /** Optional repo-scan result — supplies pagesPrefix. */
    repoScan?: RepoScanResult | null;
    /** Default preview-deployment substring (e.g. "web"). */
    previewEnvIncludes?: string;
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** "Log in" -> "log\\s*in" (matched case-insensitively against the button's accessible name). */
function submitPattern(text: string): string {
    const cleaned = text.trim().toLowerCase();
    if (!cleaned) {
        return "log\\s*in";
    }
    return cleaned.split(/\s+/).map(escapeRegExp).join("\\s*");
}

/** Same-origin pathname the login form posts to, or null when it submits via background fetch. */
function formActionPath(action: string, baseUrl: string, loginPath: string): string | null {
    const raw = action.trim();
    if (!raw || raw === "#") {
        return null;
    }
    try {
        const resolved = new URL(raw, baseUrl);
        if (new URL(baseUrl).origin !== resolved.origin) {
            return null;
        }
        return resolved.pathname || loginPath;
    } catch {
        return raw.startsWith("/") ? (raw.split("?")[0] ?? raw) : null;
    }
}

/**
 * Build an authenticated-URL regex from the model's path guess. The fragment is
 * escaped (it is an untrusted LLM string), and the result is compile-tested so a bad
 * guess can never become an invalid RegExp that would later throw in performLogin.
 */
function guessAuthUrl(guess: string | undefined): string {
    const value = (guess ?? "").trim();
    let candidate = DEFAULT_AUTH_URL_PATTERN;
    if (value.startsWith("/") && value.length <= 80) {
        candidate = /[)$]/.test(value) ? value : `${escapeRegExp(value)}(/|\\?|#|$)`;
    }
    try {
        new RegExp(candidate);
        return candidate;
    } catch {
        return DEFAULT_AUTH_URL_PATTERN;
    }
}

function defaultsProposal(
    previewEnvIncludes: string,
    repoScan: RepoScanResult | null | undefined,
    notes: string[],
    fieldMeta: Record<string, FieldMeta>,
): OnboardProposal {
    return {
        auth: {
            loginPath: "/login",
            emailLabel: "Email",
            passwordLabel: "Password",
            submitNamePattern: "log\\s*in",
            authenticatedUrlPattern: DEFAULT_AUTH_URL_PATTERN,
            emailFallbackSelector: 'input[type="email"]',
            passwordFallbackSelector: 'input[type="password"]',
            publicRoutes: ["/login"],
        },
        authRequired: true,
        previewEnvIncludes,
        pagesPrefix: repoScan?.pagesPrefix ?? null,
        knownRoutes: [],
        allowedMutationPatterns: [],
        fieldMeta,
        notes,
    };
}

/** Internal nav-link paths visible on the current page — crawl seeds for a no-auth app. */
async function harvestNavRoutes(session: { page: Page; baseUrl: string }): Promise<string[]> {
    const controls = await extractControls(session.page, [], session.baseUrl).catch(() => []);
    const routes = new Set<string>(["/"]);
    for (const control of controls) {
        if (control.kind === "navigation" && control.href) {
            const internal = resolveInternalPath(control.href, session.baseUrl);
            if (internal) {
                routes.add(internal);
            }
        }
    }
    return [...routes].slice(0, 20);
}

/** The inert auth block a no-auth proposal carries (login fields are never used). */
function inertAuth(publicRoutes: string[]): AuthStrategy {
    return {
        loginPath: "/login",
        emailLabel: "Email",
        passwordLabel: "Password",
        submitNamePattern: "log\\s*in",
        authenticatedUrlPattern: DEFAULT_AUTH_URL_PATTERN,
        emailFallbackSelector: 'input[type="email"]',
        passwordFallbackSelector: 'input[type="password"]',
        publicRoutes: publicRoutes.length > 0 ? publicRoutes : ["/"],
    };
}

/**
 * Observe a live web app and propose a generic adapter config. The detection session
 * is ALWAYS read-only with an EMPTY mutation allow-list: it only READS the login page,
 * it never submits a form, so no write ever leaves the browser. The proposed
 * `allowedMutationPatterns` comes solely from the login form's own action and is
 * returned for a human to confirm — it is never applied here.
 */
export async function detectProjectConfig(input: DetectInput): Promise<OnboardProposal> {
    const previewEnvIncludes = input.previewEnvIncludes ?? "web";
    const safety: SafetyConfig = {
        readOnly: true,
        allowedMutationPatterns: [],
        telemetryPatterns: input.telemetryPatterns,
        destructiveControlPatterns: input.destructiveControlPatterns,
        productionMarkers: [],
        failClosedOnProduction: false,
    };

    const notes: string[] = [];
    const fieldMeta: Record<string, FieldMeta> = {};

    // Log the origin+path only — the URL may carry a one-time bypass/login token.
    logger.info(`Connecting to ${stripQuery(input.baseUrl)}`);
    const session = await createSession({ baseUrl: input.baseUrl, headless: input.headless, safety });
    try {
        // 1) Load the app root and read it: does it serve content, or gate behind a login?
        let rootCount = 0;
        let rootLanded = "/";
        let rootProbe: FormProbe | null = null;
        try {
            await session.page.goto("/", { waitUntil: "domcontentloaded", timeout: 30000 });
            rootCount = await waitForInteractive(session.page, 4000);
            // Let a late client-side session check / redirect settle before sampling the URL,
            // so a gated SPA that paints a shell then bounces to login isn't read as public.
            await session.page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => null);
            await dismissOverlays(session.page);
            rootLanded = pathnameOf(session.page.url());
            rootProbe = (await session.page.evaluate(FORM_PROBE).catch(() => null)) as FormProbe | null;
        } catch {
            // root may be unreachable — fall through to hint probing / fail-safe default
        }
        const redirectedToLogin = LOGIN_REDIRECT_RE.test(rootLanded);

        // 2) Find a login form: on "/" itself, or via generic conventions if "/" had none.
        logger.info("Reading the login page");
        let loginPath: string | null = null;
        let probe: FormProbe | null = null;
        if (rootProbe?.hasPassword) {
            loginPath = rootLanded;
            probe = rootProbe;
        } else {
            for (const candidate of input.loginPathHints ?? DEFAULT_LOGIN_HINTS) {
                try {
                    await session.page.goto(candidate, { waitUntil: "domcontentloaded", timeout: 30000 });
                    await waitForInteractive(session.page, 4000);
                    await dismissOverlays(session.page);
                    const found = (await session.page.evaluate(FORM_PROBE).catch(() => null)) as FormProbe | null;
                    if (found?.hasPassword) {
                        loginPath = pathnameOf(session.page.url()) || candidate;
                        probe = found;
                        break;
                    }
                } catch {
                    // try the next candidate
                }
            }
        }

        if (!loginPath || !probe) {
            // No login form on "/" or the conventional hints. Before concluding the app is
            // public, harvest its nav and probe any login-ish link (covers non-standard routes
            // like /portal or /members). Only "/"-renders-content + no-login-redirect qualifies;
            // anything else fails safe to login-required so we never skip a real wall.
            let knownRoutes: string[] = [];
            if (rootCount > 0 && !redirectedToLogin) {
                if (pathnameOf(session.page.url()) !== rootLanded) {
                    // Probing hints navigated away — return to "/" before harvesting nav links.
                    await session.page.goto("/", { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => null);
                    await waitForInteractive(session.page, 4000);
                    await dismissOverlays(session.page);
                }
                knownRoutes = await harvestNavRoutes(session);
                for (const route of knownRoutes) {
                    if (!LOGIN_LINK_RE.test(route)) {
                        continue;
                    }
                    try {
                        await session.page.goto(route, { waitUntil: "domcontentloaded", timeout: 30000 });
                        await waitForInteractive(session.page, 4000);
                        await dismissOverlays(session.page);
                        const found = (await session.page.evaluate(FORM_PROBE).catch(() => null)) as FormProbe | null;
                        if (found?.hasPassword) {
                            loginPath = pathnameOf(session.page.url()) || route;
                            probe = found;
                            break;
                        }
                    } catch {
                        // try the next link
                    }
                }
            }

            if (!loginPath || !probe) {
                if (rootCount > 0 && !redirectedToLogin) {
                    // No login form on "/", the conventional hints, or any login-ish nav link, and
                    // "/" renders content — propose no-auth at MEDIUM confidence (a non-standard
                    // login route could still exist, so a human confirms before registering).
                    logger.info("No login detected — the app loads directly");
                    fieldMeta.authRequired = {
                        confidence: "medium",
                        source: `"/" renders ${rootCount} controls, no login form found`,
                    };
                    fieldMeta["auth.loginPath"] = { confidence: "low", source: "unused — app needs no login" };
                    if (input.repoScan?.pagesPrefix) {
                        fieldMeta.pagesPrefix = {
                            confidence: "medium",
                            source: `repo: ${input.repoScan.framework ?? "structure"}`,
                        };
                    }
                    notes.push(
                        "No login detected — the app serves content directly. Sentinel will crawl and verify without signing in; the read-only guard is unchanged. If parts of the app need a login, switch Authentication to 'Login required'.",
                    );
                    for (const note of input.repoScan?.notes ?? []) {
                        notes.push(note);
                    }
                    logger.success("Proposal ready");
                    return {
                        auth: inertAuth(knownRoutes),
                        authRequired: false,
                        previewEnvIncludes,
                        pagesPrefix: input.repoScan?.pagesPrefix ?? null,
                        knownRoutes,
                        // A no-login app has no auth POST to permit — the write allow-list stays empty.
                        allowedMutationPatterns: [],
                        fieldMeta,
                        notes,
                    };
                }
                notes.push("Could not find a login form automatically — set the login path and field labels manually.");
                return defaultsProposal(previewEnvIncludes, input.repoScan, notes, fieldMeta);
            }
            // A login-ish nav link revealed a form — fall through to the auth-required path below.
        }
        fieldMeta["auth.loginPath"] = { confidence: "high", source: "observed login form" };

        // 2) Read labels + submit text from the rendered page (screenshot + the model).
        logger.info("Inferring login fields with the model");
        const shot = await session.page.screenshot({ fullPage: true }).catch(() => null);
        const llm = await input.reasoner
            .generateObject({
                prompt: `This is the login page at ${loginPath}. From what is visible, identify: the email/username field's label or placeholder; the password field's label; the submit button's exact visible text; any links to public (no-auth) pages such as sign-up or password reset (return their href paths); and your best guess of the URL path the app navigates to right after a successful login, as a short path fragment like "/dashboard". Use only what is visible — never invent a field that is not shown.`,
                system: "You read a web app's login screen and emit a precise, minimal structured description for automating sign-in.",
                schema: LLM_SCHEMA,
                images: shot ? [shot] : undefined,
                maxTokens: 700,
                telemetryLabel: "onboard-detect",
            })
            .catch(() => null);

        const emailLabel = (llm?.emailLabel ?? "").trim() || "Email";
        const passwordLabel = (llm?.passwordLabel ?? "").trim() || "Password";
        const submitText = (llm?.submitText ?? probe.submitText ?? "").trim();
        fieldMeta["auth.emailLabel"] = {
            confidence: llm?.emailLabel ? "high" : "low",
            source: llm?.emailLabel ? "login screen" : "default",
        };
        fieldMeta["auth.passwordLabel"] = {
            confidence: llm?.passwordLabel ? "high" : "low",
            source: llm?.passwordLabel ? "login screen" : "default",
        };
        fieldMeta["auth.submitNamePattern"] = {
            confidence: submitText ? "high" : "low",
            source: submitText ? "submit button text" : "default",
        };
        fieldMeta["auth.authenticatedUrlPattern"] = {
            confidence: "low",
            source: "inferred — verify after first login",
        };

        const publicSet = new Set<string>([loginPath]);
        for (const link of llm?.publicLinks ?? []) {
            const internal = resolveInternalPath(link, input.baseUrl);
            if (internal) {
                publicSet.add(internal);
            }
        }
        fieldMeta["auth.publicRoutes"] = { confidence: "medium", source: "login-page links" };

        // 3) Mutation pattern: ONLY from the login form's own action (a write-free signal).
        //    We never submit, so an API-fetch login (no form action) leaves this empty and
        //    the human supplies the anchored auth endpoint.
        const allowedMutationPatterns: RegExpSource[] = [];
        const actionPath = formActionPath(probe.action, input.baseUrl, loginPath);
        if (actionPath) {
            allowedMutationPatterns.push(`^${escapeRegExp(actionPath)}$`);
            fieldMeta["allowedMutationPatterns"] = {
                confidence: "medium",
                source: "login form action — confirm before use",
            };
        } else {
            notes.push(
                "The login submits via a background request, not a form action — set the auth endpoint in 'Allowed mutation patterns' (anchored, e.g. ^/api/auth/login$).",
            );
            fieldMeta["allowedMutationPatterns"] = { confidence: "low", source: "not detected — set manually" };
        }

        const pagesPrefix = input.repoScan?.pagesPrefix ?? null;
        if (pagesPrefix) {
            fieldMeta["pagesPrefix"] = {
                confidence: "medium",
                source: `repo: ${input.repoScan?.framework ?? "structure"}`,
            };
        }
        for (const note of input.repoScan?.notes ?? []) {
            notes.push(note);
        }

        const auth: AuthStrategy = {
            loginPath,
            emailLabel,
            passwordLabel,
            submitNamePattern: submitPattern(submitText),
            authenticatedUrlPattern: guessAuthUrl(llm?.authenticatedUrlGuess),
            emailFallbackSelector: 'input[type="email"]',
            passwordFallbackSelector: 'input[type="password"]',
            publicRoutes: [...publicSet],
        };

        logger.success("Proposal ready");
        return {
            auth,
            authRequired: true,
            previewEnvIncludes,
            pagesPrefix,
            knownRoutes: [],
            allowedMutationPatterns,
            fieldMeta,
            notes,
        };
    } finally {
        await session.close();
    }
}
