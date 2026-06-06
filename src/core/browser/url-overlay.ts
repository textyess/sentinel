import type { BrowserContext } from "playwright";

/**
 * A faux address bar for recorded runs. Playwright records the page, not the
 * browser chrome, so the real URL bar never appears in the video — a viewer can't
 * tell which page the agent is on. This injects a small fixed pill that shows the
 * current path, so every recording is self-labelling.
 *
 * It stays correct as the agent moves: rebuilt on every full navigation (the init
 * script re-runs per document), and updated in place on client-side route changes
 * by wrapping history.pushState/replaceState and listening for popstate/hashchange,
 * with a low-frequency poll as a safety net for routers that bypass all of those.
 *
 * Shows the pathname ONLY — never the origin, query string, or hash — so the pill
 * stays compact and one-time tokens in a URL (magic links, OAuth fragments) are
 * never baked into a shared recording. This mirrors how the interaction graph and
 * manifest already drop query strings (see resolveInternalPath / stripQuery).
 *
 * Purely cosmetic: pointer-events:none, no network, no app-specific knowledge.
 * Installed by the driver only when a run is being recorded.
 */
const URL_BAR_INIT_SCRIPT = `(() => {
  if (window.__sentinelUrlBar) { return; }
  window.__sentinelUrlBar = true;
  var current = function () {
    try { return location.pathname || '/'; } catch (e) { return '/'; }
  };
  var attach = function () {
    if (!document.body) { return; }
    var style = document.createElement('style');
    style.textContent = '#__sentinel_urlbar{position:fixed;left:50%;bottom:18px;transform:translateX(-50%);display:flex;align-items:center;gap:8px;max-width:82vw;padding:7px 16px 7px 12px;border-radius:999px;font:600 13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;color:#e6edf3;background:rgba(22,27,34,.86);border:1px solid rgba(240,246,252,.14);box-shadow:0 8px 24px rgba(0,0,0,.4);pointer-events:none;z-index:2147483646;white-space:nowrap;overflow:hidden}' +
      '#__sentinel_urlbar .__s_dot{flex:0 0 auto;width:9px;height:9px;border-radius:50%;background:#3fb950;box-shadow:0 0 0 3px rgba(63,185,80,.22)}' +
      '#__sentinel_urlbar .__s_u{overflow:hidden;text-overflow:ellipsis;letter-spacing:.01em}';
    (document.head || document.documentElement).appendChild(style);
    var bar = document.createElement('div');
    bar.id = '__sentinel_urlbar';
    bar.setAttribute('aria-hidden', 'true');
    var dot = document.createElement('span'); dot.className = '__s_dot';
    var u = document.createElement('span'); u.className = '__s_u';
    bar.appendChild(dot); bar.appendChild(u);
    document.body.appendChild(bar);
    var last = '';
    var render = function () { var c = current(); if (c !== last) { last = c; u.textContent = c; } };
    render();
    var wrap = function (name) {
      var orig = history[name];
      if (typeof orig !== 'function') { return; }
      history[name] = function () { var r = orig.apply(this, arguments); render(); return r; };
    };
    wrap('pushState'); wrap('replaceState');
    window.addEventListener('popstate', render, true);
    window.addEventListener('hashchange', render, true);
    setInterval(render, 400);
  };
  if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', attach); } else { attach(); }
})();`;

/** Install the address-bar overlay on every page of this context. Call before creating pages. */
export async function enableUrlOverlay(context: BrowserContext): Promise<void> {
    await context.addInitScript(URL_BAR_INIT_SCRIPT);
}
