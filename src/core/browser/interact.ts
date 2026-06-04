import type { Page } from "playwright";

/** Click the first ranked selector that resolves to exactly one element (no ambiguous clicks). */
export async function clickBySelectors(page: Page, selectors: string[], timeoutMs: number): Promise<boolean> {
    for (const selector of selectors) {
        try {
            const locator = page.locator(selector);
            if ((await locator.count()) !== 1) {
                continue;
            }
            await locator.click({ timeout: timeoutMs });
            return true;
        } catch {
            // Self-heal: try the next, more specific ranked selector.
        }
    }
    return false;
}

/** Fill the first ranked selector that resolves to exactly one element. */
export async function fillBySelectors(
    page: Page,
    selectors: string[],
    value: string,
    timeoutMs: number,
): Promise<boolean> {
    for (const selector of selectors) {
        try {
            const locator = page.locator(selector);
            if ((await locator.count()) !== 1) {
                continue;
            }
            await locator.fill(value, { timeout: timeoutMs });
            return true;
        } catch {
            // try the next selector
        }
    }
    return false;
}
