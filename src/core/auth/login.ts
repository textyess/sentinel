import type { Locator, Page } from "playwright";
import type { AuthStrategy, Credentials } from "../types";

export interface LoginResult {
    landedUrl: string;
    needsOrganizationSelection: boolean;
}

export interface LoginOptions {
    /** Per-step timeout. Generous by default to tolerate Next.js dev cold-compile of the login route. */
    timeoutMs?: number;
}

function fieldLocator(page: Page, primary: Locator, fallbackSelector?: string): Locator {
    return fallbackSelector ? primary.or(page.locator(fallbackSelector)).first() : primary.first();
}

/**
 * Drive the multi-step login. Mirrors the recipe proven by the repo's own
 * Playwright auth setup: exact-label fields (the password input ships an inline
 * show/hide toggle, so a loose match resolves to two elements), submit the form,
 * then wait to land on an authenticated route. Falls back to a CSS selector if
 * the label association ever changes, and surfaces an actionable error when the
 * app swallows a bad-credentials response and stays on the login page.
 */
export async function performLogin(
    page: Page,
    auth: AuthStrategy,
    credentials: Credentials,
    options: LoginOptions = {},
): Promise<LoginResult> {
    const timeout = options.timeoutMs ?? 45000;

    await page.goto(auth.loginPath, { waitUntil: "domcontentloaded", timeout });

    const email = fieldLocator(page, page.getByLabel(auth.emailLabel, { exact: true }), auth.emailFallbackSelector);
    await email.waitFor({ state: "visible", timeout });
    await email.fill(credentials.email);

    const password = fieldLocator(
        page,
        page.getByLabel(auth.passwordLabel, { exact: true }),
        auth.passwordFallbackSelector,
    );
    await password.fill(credentials.password);

    await page
        .getByRole("button", { name: new RegExp(auth.submitNamePattern, "i") })
        .first()
        .click();

    try {
        await page.waitForURL(new RegExp(auth.authenticatedUrlPattern), { timeout });
    } catch (error) {
        const url = page.url();
        if (url.includes(auth.loginPath)) {
            throw new Error(
                `Login did not complete — still on ${url}. Check SENTINEL_EMAIL / SENTINEL_PASSWORD ` +
                    "(against prod, the seeded test users do not exist).",
            );
        }
        throw new Error(
            `Login did not reach an authenticated route in ${timeout}ms (last URL: ${url}). ` +
                (error instanceof Error ? error.message : String(error)),
        );
    }

    const landedUrl = page.url();
    return {
        landedUrl,
        needsOrganizationSelection: /\/organizations(\/|\?|#|$)/.test(landedUrl),
    };
}
