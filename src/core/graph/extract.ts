import { createHash } from "node:crypto";
import type { Page } from "playwright";
import type { ControlKind, ControlRef } from "./types";
import { resolveInternalPath } from "./url";

interface RawControl {
    tag: string;
    role: string;
    name: string;
    /** True when the accessible name was longer than the capture limit (exact selectors would miss it). */
    truncated: boolean;
    href: string | null;
    testId: string | null;
    id: string | null;
    cssPath: string;
}

const INTERACTIVE_SELECTOR =
    'a[href], button, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="menuitemradio"], [role="switch"], [role="checkbox"], input:not([type="hidden"]), select, textarea';

/**
 * Wait until the page has rendered interactive content and the count has settled,
 * so the crawler never extracts a half-rendered shell (which yields 0 controls).
 * Returns the final count; resolves early once stable, or at the timeout.
 *
 * Polls fast (POLL_MS) but still needs two consecutive equal, non-zero reads — so a
 * ready page clears in ~2 polls instead of dwelling on the timeout. This floor is
 * paid after every navigation and every click, so keeping it small matters; the
 * two-read quiescence is what guards against catching a mid-render frame.
 */
const POLL_MS = 150;

export async function waitForInteractive(page: Page, timeoutMs: number): Promise<number> {
    const deadline = Date.now() + timeoutMs;
    const countExpr = `document.querySelectorAll(${JSON.stringify(INTERACTIVE_SELECTOR)}).length`;
    let last = -1;
    let stable = 0;
    let count = 0;
    while (Date.now() < deadline) {
        count = ((await page.evaluate(countExpr).catch(() => 0)) as number) ?? 0;
        if (count > 0 && count === last) {
            stable += 1;
            if (stable >= 2) {
                return count;
            }
        } else {
            stable = 0;
        }
        last = count;
        await page.waitForTimeout(POLL_MS);
    }
    return count;
}

/**
 * Dismiss transient overlays (a "What's new" dialog, cookie banner, intercom popup)
 * by pressing Escape, so extraction sees the real page — not a modal that happens
 * to be showing. Radix/shadcn dialogs close on Escape. Best-effort and harmless.
 */
export async function dismissOverlays(page: Page): Promise<void> {
    try {
        // Only act when a modal dialog is actually present, so Escape can't cancel a
        // legitimate inline editor / wizard and perturb the page state we're mapping.
        const overlay = page.locator('[role="dialog"], [role="alertdialog"]');
        if ((await overlay.count()) > 0) {
            await page.keyboard.press("Escape");
            await page.waitForTimeout(250);
        }
    } catch {
        // No overlay present, or nothing focusable — fine.
    }
}

/**
 * Runs in the page to collect visible interactive controls with a stable-ish CSS
 * path. Passed as a STRING (not a function) on purpose: the tsx/esbuild transform
 * injects a `__name` helper into compiled functions that does not exist in the
 * browser context, so a function literal here would throw "__name is not defined".
 */
const EXTRACT_CONTROLS_JS = `(() => {
  const sel = ${JSON.stringify(INTERACTIVE_SELECTOR)};
  const els = Array.from(document.querySelectorAll(sel));
  const out = [];
  for (const el of els) {
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    if (!(rect.width > 0 && rect.height > 0) || style.visibility === 'hidden' || style.display === 'none') continue;
    const tag = el.tagName.toLowerCase();
    let role = el.getAttribute('role') || '';
    if (!role) {
      if (tag === 'a') role = 'link';
      else if (tag === 'button') role = 'button';
      else if (tag === 'select') role = 'combobox';
      else if (tag === 'textarea') role = 'textbox';
      else if (tag === 'input') {
        const t = (el.getAttribute('type') || 'text').toLowerCase();
        role = t === 'checkbox' ? 'checkbox' : t === 'radio' ? 'radio' : (t === 'submit' || t === 'button') ? 'button' : 'textbox';
      }
    }
    const rawText = typeof el.innerText === 'string' ? el.innerText : (el.textContent || '');
    const fullName = (el.getAttribute('aria-label') || rawText.replace(/\\s+/g, ' ').trim() || el.getAttribute('title') || el.getAttribute('placeholder') || el.getAttribute('value') || '');
    const name = fullName.slice(0, 100);
    const href = tag === 'a' ? el.getAttribute('href') : null;
    const testId = el.getAttribute('data-testid') || el.getAttribute('data-test-id') || null;
    const id = el.getAttribute('id') || null;
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 5) {
      const pid = node.getAttribute('id');
      if (pid) { parts.unshift('#' + (window.CSS && CSS.escape ? CSS.escape(pid) : pid)); break; }
      let part = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent) {
        const sibs = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
        if (sibs.length > 1) part += ':nth-of-type(' + (sibs.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
      node = node.parentElement;
    }
    out.push({ tag, role, name, truncated: fullName.length > 100, href, testId, id, cssPath: parts.join(' > ') });
  }
  return out;
})()`;

function cssEscapeId(id: string): string {
    return id.replace(/([^a-zA-Z0-9_-])/g, "\\$1");
}

function buildSelectors(raw: RawControl): string[] {
    const selectors: string[] = [];
    // Playwright role=name is an EXACT match — only emit it when the name is whole.
    if (raw.role && raw.name && !raw.truncated) {
        selectors.push(`role=${raw.role}[name=${JSON.stringify(raw.name)}i]`);
    }
    if (raw.testId) {
        selectors.push(`[data-testid=${JSON.stringify(raw.testId)}]`);
    }
    if (raw.id) {
        selectors.push(`#${cssEscapeId(raw.id)}`);
    }
    if (raw.cssPath) {
        selectors.push(raw.cssPath);
    }
    return selectors;
}

function kindOf(raw: RawControl, internalHref: string | null): ControlKind {
    if ((raw.tag === "a" || raw.role === "link") && internalHref) {
        return "navigation";
    }
    if (raw.tag === "input" || raw.tag === "select" || raw.tag === "textarea") {
        return "input";
    }
    if (raw.role === "button" || raw.role === "tab" || raw.role === "menuitem" || raw.tag === "button") {
        return "action";
    }
    return "unknown";
}

const MAX_CONTROLS_PER_PAGE = 250;

export async function extractControls(page: Page, destructive: RegExp[], baseUrl: string): Promise<ControlRef[]> {
    const raw = (await page.evaluate(EXTRACT_CONTROLS_JS)) as RawControl[];
    const controls: ControlRef[] = [];
    const seen = new Set<string>();

    for (const item of raw) {
        const internalHref = item.href ? resolveInternalPath(item.href, baseUrl) : null;
        const dedupeKey = `${item.role}|${item.name}|${internalHref ?? ""}|${item.cssPath}`;
        if (seen.has(dedupeKey)) {
            continue;
        }
        seen.add(dedupeKey);
        controls.push({
            role: item.role || item.tag,
            name: item.name,
            selectors: buildSelectors(item),
            href: internalHref,
            destructive: item.name ? destructive.some((re) => re.test(item.name)) : false,
            kind: kindOf(item, internalHref),
        });
    }

    // Never let an in-page-control flood crowd out navigation links (which drive coverage).
    if (controls.length > MAX_CONTROLS_PER_PAGE) {
        const nav = controls.filter((c) => c.kind === "navigation");
        const rest = controls.filter((c) => c.kind !== "navigation");
        return [...nav, ...rest].slice(0, Math.max(MAX_CONTROLS_PER_PAGE, nav.length));
    }
    return controls;
}

/** Strip volatile text (digit runs) so dynamic labels don't change the fingerprint. */
function stripVolatile(name: string): string {
    return name.toLowerCase().replace(/\d+/g, "#").trim();
}

/**
 * A structural, load-stable signature that distinguishes page states without
 * folding in volatile per-record text — so the same logical page hashes to the
 * same node id across crawls (which is what cross-PR diffing relies on).
 */
export function stateSignature(normalizedPath: string, controls: ControlRef[]): string {
    const fingerprint = controls
        .map((c) => `${c.kind}:${c.role}:${c.href ?? stripVolatile(c.name)}`)
        .sort()
        .join(",");
    return createHash("sha1").update(`${normalizedPath}|${fingerprint}`).digest("hex").slice(0, 12);
}
