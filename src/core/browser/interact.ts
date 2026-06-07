import type { Locator, Page } from "playwright";
import { glide, isCursorActive } from "./cursor";

/**
 * Move the visible cursor to a locator's centre before acting on it, so a recorded
 * run shows the pointer travelling to the control rather than the click appearing
 * from nowhere. No-op (and zero extra round-trips) when the run isn't recorded, and
 * never throws — positioning the cursor is cosmetic; the real interaction follows.
 */
export async function moveCursorToLocator(page: Page, locator: Locator, timeoutMs: number): Promise<void> {
    if (!isCursorActive(page)) {
        return;
    }
    try {
        await locator.scrollIntoViewIfNeeded({ timeout: timeoutMs });
        const box = await locator.boundingBox({ timeout: timeoutMs });
        if (box) {
            await glide(page, box.x + box.width / 2, box.y + box.height / 2);
        }
    } catch {
        // The cursor is decorative; if it can't be positioned, the action below still runs.
    }
}

/**
 * Click the first ranked selector that resolves to exactly one element (no ambiguous
 * clicks). Returns the selector that worked, or null if none did — a caller can compare
 * it against the skill-recorded selectors to tell when self-heal fell through to a live one.
 */
export async function clickBySelectorsTracked(
    page: Page,
    selectors: string[],
    timeoutMs: number,
): Promise<string | null> {
    for (const selector of selectors) {
        try {
            const locator = page.locator(selector);
            if ((await locator.count()) !== 1) {
                continue;
            }
            await moveCursorToLocator(page, locator, timeoutMs);
            await locator.click({ timeout: timeoutMs });
            return selector;
        } catch {
            // Self-heal: try the next, more specific ranked selector.
        }
    }
    return null;
}

/** Click the first ranked selector that resolves to exactly one element (no ambiguous clicks). */
export async function clickBySelectors(page: Page, selectors: string[], timeoutMs: number): Promise<boolean> {
    return (await clickBySelectorsTracked(page, selectors, timeoutMs)) !== null;
}

/** Fill the first ranked selector that resolves to exactly one element. Returns the selector that worked, or null. */
export async function fillBySelectorsTracked(
    page: Page,
    selectors: string[],
    value: string,
    timeoutMs: number,
): Promise<string | null> {
    for (const selector of selectors) {
        try {
            const locator = page.locator(selector);
            if ((await locator.count()) !== 1) {
                continue;
            }
            await moveCursorToLocator(page, locator, timeoutMs);
            await locator.fill(value, { timeout: timeoutMs });
            return selector;
        } catch {
            // try the next selector
        }
    }
    return null;
}

/** Fill the first ranked selector that resolves to exactly one element. */
export async function fillBySelectors(
    page: Page,
    selectors: string[],
    value: string,
    timeoutMs: number,
): Promise<boolean> {
    return (await fillBySelectorsTracked(page, selectors, value, timeoutMs)) !== null;
}
