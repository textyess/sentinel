import type { BrowserContext, Page } from "playwright";

/**
 * A visible mock cursor for recorded runs. Playwright records the page DOM, not the
 * OS pointer, so without this the video only ever shows the *result* of a click —
 * never the pointer travelling to it. Two halves work together:
 *
 *  - an injected overlay (below): a dumb DOM follower — a dot that tracks real mouse
 *    events and pulses on press; and
 *  - `glide()` on the Node side: it walks Playwright's mouse to a target in small,
 *    time-spaced steps so the overlay visibly travels across the page before a click,
 *    instead of teleporting (Playwright's own click moves the pointer in one jump).
 *
 * Purely cosmetic: pointer-events:none, no network, no app-specific knowledge. Only
 * installed (and only glided) when a run is being recorded.
 */

/** Duration of the overlay's position tween — also the post-glide settle, so the click pulse lands on target. */
const POSITION_TWEEN_MS = 90;
/** Total travel time of a glide. Spans ~GLIDE_STEPS frames at the recorder's rate, so the motion reads on video. */
const GLIDE_MS = 420;
const GLIDE_STEPS = 16;

const CURSOR_INIT_SCRIPT = `(() => {
  if (window.__sentinelCursor) { return; }
  window.__sentinelCursor = true;
  var attach = function () {
    if (!document.body) { return; }
    var style = document.createElement('style');
    style.textContent = '#__sentinel_cursor{position:fixed;top:0;left:0;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;background:rgba(88,166,255,.35);border:2px solid #58a6ff;box-shadow:0 0 0 1px rgba(0,0,0,.45);pointer-events:none;z-index:2147483647;transition:left ${POSITION_TWEEN_MS}ms linear,top ${POSITION_TWEEN_MS}ms linear,width .12s,height .12s,margin .12s,background .12s}' +
      '#__sentinel_cursor.down{width:30px;height:30px;margin:-15px 0 0 -15px;background:rgba(88,166,255,.55)}' +
      '#__sentinel_cursor::after{content:"";position:absolute;inset:-4px;border-radius:50%;border:2px solid rgba(88,166,255,.9);opacity:0}' +
      '#__sentinel_cursor.down::after{animation:__sentinel_ping .45s ease-out}' +
      '@keyframes __sentinel_ping{from{opacity:.9;transform:scale(.4)}to{opacity:0;transform:scale(2.4)}}';
    (document.head || document.documentElement).appendChild(style);
    var dot = document.createElement('div');
    dot.id = '__sentinel_cursor';
    dot.setAttribute('aria-hidden', 'true');
    document.body.appendChild(dot);
    document.addEventListener('mousemove', function (e) { dot.style.left = e.clientX + 'px'; dot.style.top = e.clientY + 'px'; }, true);
    document.addEventListener('mousedown', function () { dot.classList.add('down'); }, true);
    document.addEventListener('mouseup', function () { dot.classList.remove('down'); }, true);
  };
  if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', attach); } else { attach(); }
})();`;

/** Contexts whose pages carry the cursor overlay — set by the driver only when recording. */
const cursorContexts = new WeakSet<BrowserContext>();
/** Last cursor position per page, so a glide knows where to travel *from*. */
const lastPosition = new WeakMap<Page, { x: number; y: number }>();

/** Install the overlay on every page of this context and mark it cursor-driven. Call before creating pages. */
export async function enableCursor(context: BrowserContext): Promise<void> {
    await context.addInitScript(CURSOR_INIT_SCRIPT);
    cursorContexts.add(context);
}

/** Whether this page's run is being recorded with the visible cursor (so movement is worth animating). */
export function isCursorActive(page: Page): boolean {
    return cursorContexts.has(page.context());
}

/** Decelerate into the target — a fast start that eases to a stop reads as a deliberate, human pointer landing. */
function easeOut(t: number): number {
    return 1 - Math.pow(1 - t, 3);
}

/**
 * Walk Playwright's mouse from its last known point to (x, y) in small, time-spaced
 * steps, so the overlay glides across the page instead of teleporting. No-op unless
 * the page is cursor-driven. Best-effort — cursor motion must never break (or, when
 * off, slow) an action.
 */
export async function glide(page: Page, x: number, y: number): Promise<void> {
    if (!isCursorActive(page)) {
        return;
    }
    const from = lastPosition.get(page) ?? { x: 0, y: 0 };
    const perStepMs = Math.round(GLIDE_MS / GLIDE_STEPS);
    for (let step = 1; step <= GLIDE_STEPS; step++) {
        const t = easeOut(step / GLIDE_STEPS);
        await page.mouse.move(from.x + (x - from.x) * t, from.y + (y - from.y) * t).catch(() => {});
        await page.waitForTimeout(perStepMs).catch(() => {});
    }
    // Let the overlay's position tween finish so the click pulse lands on target, not mid-flight.
    await page.waitForTimeout(POSITION_TWEEN_MS).catch(() => {});
    lastPosition.set(page, { x, y });
}
