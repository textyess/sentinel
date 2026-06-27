import type { Page } from "playwright";
import { isCursorActive } from "../browser/cursor";

/**
 * Human-like pacing. Two behaviours:
 *  - a short randomized "think" pause before an action (navigate / click), and
 *  - an adaptive dwell that spends time proportional to how much is on the page
 *    (content-rich pages get read + scrolled; sparse pages get skimmed).
 * This makes recorded runs look like a person using the app, lets async content
 * finish rendering, and is the agent's proxy for "this page is worth more time".
 *
 * Pacing is a recording cosmetic, exactly like the visible cursor: both only earn
 * their cost when a human will watch the video. So both no-op unless the run is
 * recorded (`isCursorActive`). A non-recorded run — the baseline crawl, onboarding
 * detection — produces a graph, not a video, and so pays none of this latency;
 * `waitForInteractive` still handles render-settle there.
 */
export interface PacingOptions {
    enabled: boolean;
    /** Base think-time between actions (ms); actual is jittered 0.6x–1.6x. */
    baseThinkMs: number;
    /** Hard cap on per-page dwell (ms). */
    maxDwellMs: number;
}

interface PageMetrics {
    controls: number;
    height: number;
    viewport: number;
}

const MEASURE_JS = `(() => {
  const sel = 'a[href], button, [role="button"], input, select, textarea, table, [role="row"]';
  return {
    controls: document.querySelectorAll(sel).length,
    height: (document.body && document.body.scrollHeight) || 0,
    viewport: window.innerHeight || 800,
  };
})()`;

/** Jitter a base duration to 0.6x–1.6x so pauses never look mechanical. */
function jitter(baseMs: number): number {
    return Math.round(baseMs * (0.6 + Math.random()));
}

async function measure(page: Page): Promise<PageMetrics> {
    const result = await page.evaluate(MEASURE_JS).catch(() => null);
    if (result && typeof result === "object") {
        return result as PageMetrics;
    }
    return { controls: 0, height: 0, viewport: 800 };
}

/** A short randomized pause before an action (navigate, click). */
export async function thinkPause(page: Page, pacing: PacingOptions): Promise<void> {
    if (!pacing.enabled || !isCursorActive(page)) {
        return;
    }
    await page.waitForTimeout(jitter(pacing.baseThinkMs)).catch(() => {});
}

/**
 * Dwell on the current page like a person: more time the more there is to read,
 * scrolling through tall pages in steps. Returns the target dwell taken (ms).
 */
export async function humanDwell(page: Page, pacing: PacingOptions): Promise<number> {
    if (!pacing.enabled || !isCursorActive(page)) {
        return 0;
    }
    const metrics = await measure(page);
    // Time proportional to content (controls + page height), capped.
    const target = Math.min(pacing.maxDwellMs, 700 + metrics.controls * 50 + Math.min(metrics.height, 4000) * 0.3);

    if (metrics.height > metrics.viewport * 1.2) {
        const steps = Math.min(4, Math.ceil(metrics.height / metrics.viewport));
        const perStep = Math.min(pacing.baseThinkMs, target / (steps + 1));
        for (let i = 0; i < steps; i++) {
            await page.mouse.wheel(0, metrics.viewport * 0.85).catch(() => {});
            await page.waitForTimeout(jitter(perStep)).catch(() => {});
        }
        await page.evaluate("window.scrollTo({ top: 0 })").catch(() => {});
        await page.waitForTimeout(jitter(Math.min(pacing.baseThinkMs, target / 3))).catch(() => {});
    } else {
        await page.waitForTimeout(jitter(target)).catch(() => {});
    }
    return Math.round(target);
}
