import type { BrowserContext, Page } from "playwright";

/**
 * A visible mock cursor for recorded runs. Playwright records the page DOM, not the
 * OS pointer, so without this the video only ever shows the *result* of a click —
 * never the pointer travelling to it. Two halves work together:
 *
 *  - an injected overlay (below): a dumb DOM follower — a macOS-style arrow pointer
 *    with a soft highlight that tracks real mouse events and pulses on press; and
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

/**
 * The pointer itself: a real macOS-style arrow (near-black fill, white outline) so
 * the recording reads as a pointer, not an abstract dot. Its tip is the hotspot at
 * SVG (1.5, 1.5); the overlay's negative margin lands that tip on the actual mouse
 * point. Encoded with encodeURIComponent (double-quoted attributes only) so the
 * data URI carries no quotes/spaces and drops safely into the unquoted url(...).
 */
const ARROW_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="22" viewBox="0 0 16 22">' +
    '<path d="M1.5 1.5 L1.5 19 L6.2 14.7 L9.1 21 L11.4 20 L8.5 14 L14.5 14 Z" ' +
    'fill="#1f2328" stroke="#ffffff" stroke-width="1.5" stroke-linejoin="round"/></svg>';
const ARROW_DATA_URI = `data:image/svg+xml,${encodeURIComponent(ARROW_SVG)}`;

const CURSOR_INIT_SCRIPT = `(() => {
  if (window.__sentinelCursor) { return; }
  window.__sentinelCursor = true;
  var attach = function () {
    if (!document.body) { return; }
    var style = document.createElement('style');
    style.textContent = '#__sentinel_cursor{position:fixed;top:0;left:0;width:34px;height:34px;margin:-1.5px 0 0 -1.5px;pointer-events:none;z-index:2147483647;background:radial-gradient(circle 14px at 6px 7px,rgba(255,209,32,.55),rgba(255,209,32,.22) 45%,rgba(255,209,32,0) 72%);transition:left ${POSITION_TWEEN_MS}ms linear,top ${POSITION_TWEEN_MS}ms linear,background .12s ease}' +
      '#__sentinel_cursor::after{content:"";position:absolute;inset:0;background:url(${ARROW_DATA_URI}) no-repeat 0 0;background-size:16px 22px;filter:drop-shadow(0 1px 1.5px rgba(0,0,0,.5));transition:transform .12s ease;transform-origin:1.5px 1.5px}' +
      '#__sentinel_cursor.down{background:radial-gradient(circle 17px at 6px 7px,rgba(255,209,32,.85),rgba(255,209,32,.32) 45%,rgba(255,209,32,0) 72%)}' +
      '#__sentinel_cursor.down::after{transform:scale(.86)}' +
      '#__sentinel_cursor::before{content:"";position:absolute;left:6px;top:7px;width:10px;height:10px;margin:-5px 0 0 -5px;border-radius:50%;border:2px solid rgba(255,199,0,.95);opacity:0}' +
      '#__sentinel_cursor.down::before{animation:__sentinel_ping .5s ease-out}' +
      '@keyframes __sentinel_ping{from{opacity:.85;transform:scale(.6)}to{opacity:0;transform:scale(3.4)}}';
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
