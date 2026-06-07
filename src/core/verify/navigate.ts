import type { Page } from "playwright";
import { clickBySelectors } from "../browser/interact";
import { dismissOverlays, extractControls, waitForInteractive } from "../graph/extract";
import type { ControlRef, EdgeVia, GraphEdge, InteractionGraph } from "../graph/types";
import { isLoginPath, normalizePath } from "../graph/url";

export interface NavigateOptions {
    destructive: RegExp[];
    baseUrl: string;
    loginPath: string;
    settleMs: number;
    navTimeoutMs: number;
    clickTimeoutMs: number;
}

export interface NavOutcome {
    /** How the destination was reached. "goto" means no in-app route was found and the URL was loaded directly. */
    method: "already" | "click" | "click-path" | "goto";
    ok: boolean;
    observation: string;
}

/** Clicks to chase toward the target (open a menu, click the revealed link, ...) before giving up. */
const MAX_HOPS = 5;

/** The page's templated path, the same shape used as a graph node's `url`. */
function templated(pathOrUrl: string, baseUrl: string): string {
    return normalizePath(pathOrUrl, baseUrl).path;
}

/**
 * Reduce a planner-produced route string to a bare path. The planner is asked for a
 * path, but sometimes decorates a 'navigate' target with a human hint, e.g.
 * "/agents (via 'Agents button in sidebar')" or "/home — the dashboard". Loaded
 * verbatim that 404s: the browser percent-encodes the spaces, so the address bar
 * becomes "/agents%20(via%20...)". A real URL path carries no unescaped space or
 * "(" (they are %20/%28), so the leading token before either is the path; the
 * origin is stripped and a leading slash ensured.
 */
export function toTargetPath(rawTarget: string): string {
    const token = rawTarget.trim().split(/[\s(]/, 1)[0] ?? "";
    const noOrigin = token.replace(/^https?:\/\/[^/]+/, "");
    if (noOrigin === "") {
        return "/";
    }
    return noOrigin.startsWith("/") ? noOrigin : `/${noOrigin}`;
}

/** Ranked, self-healing selectors for re-clicking a control the crawl recorded as an edge. */
function selectorsForVia(via: EdgeVia): string[] {
    const selectors: string[] = [];
    if (via.role && via.name) {
        selectors.push(`role=${via.role}[name=${JSON.stringify(via.name)}i]`);
    }
    if (via.selector) {
        selectors.push(via.selector);
    }
    return selectors;
}

/** Let the page settle after a navigation and report the templated path it landed on. */
async function settle(page: Page, opts: NavigateOptions): Promise<string> {
    await waitForInteractive(page, opts.settleMs);
    return templated(page.url(), opts.baseUrl);
}

interface LiveClick {
    name: string;
    /** The templated path after the click. */
    landed: string;
    /** True when the click changed the page's path (a real navigation, not a no-op). */
    moved: boolean;
    login: boolean;
}

/**
 * Click a nav link/menu item that is visible on the page right now and points at
 * the target. This is the plain case (a sidebar/topbar link) and also closes out
 * a disclosure: once a menu has been opened, the link it revealed is matched here.
 */
async function clickLiveLinkTo(
    page: Page,
    targetPath: string,
    targetNorm: string,
    opts: NavigateOptions,
): Promise<LiveClick | null> {
    const before = templated(page.url(), opts.baseUrl);
    const controls = await extractControls(page, opts.destructive, opts.baseUrl).catch((): ControlRef[] => []);
    const navLinks = controls.filter((c) => c.kind === "navigation" && !c.destructive && c.href !== null);
    // Prefer an exact path match; fall back to a templated match so a dynamic route still resolves.
    const match =
        navLinks.find((c) => c.href === targetPath) ??
        navLinks.find((c) => c.href !== null && templated(c.href, opts.baseUrl) === targetNorm);
    if (!match || !(await clickBySelectors(page, match.selectors, opts.clickTimeoutMs))) {
        return null;
    }
    const landed = await settle(page, opts);
    return { name: match.name, landed, moved: landed !== before, login: isLoginPath(page.url(), opts.loginPath) };
}

/**
 * The control to click next to get closer to the target: the first edge's `via`
 * on a shortest path (BFS) from any node matching the current path to any node
 * matching the target. For a link behind a collapsed group the crawl recorded the
 * group's opener as that `via` — so clicking it reveals the link, which the next
 * loop turn then clicks. Edges never carry destructive controls (the crawl
 * excludes them), so following one is safe. Null when the map knows no route.
 */
function nextControlToward(graph: InteractionGraph, currentNorm: string, targetNorm: string): EdgeVia | null {
    const sources = Object.values(graph.nodes)
        .filter((n) => n.url === currentNorm)
        .map((n) => n.id);
    const targets = new Set(
        Object.values(graph.nodes)
            .filter((n) => n.url === targetNorm)
            .map((n) => n.id),
    );
    if (sources.length === 0 || targets.size === 0) {
        return null;
    }

    const adjacency = new Map<string, GraphEdge[]>();
    for (const edge of graph.edges) {
        const list = adjacency.get(edge.from);
        if (list) {
            list.push(edge);
        } else {
            adjacency.set(edge.from, [edge]);
        }
    }

    // Each frontier entry remembers the very first control taken from a source node,
    // which is the one to click now; BFS guarantees the shortest such route.
    const queue: { node: string; firstVia: EdgeVia | null }[] = sources.map((node) => ({ node, firstVia: null }));
    const visited = new Set<string>(sources);
    while (queue.length > 0) {
        const current = queue.shift();
        if (!current) {
            break;
        }
        for (const edge of adjacency.get(current.node) ?? []) {
            const firstVia = current.firstVia ?? edge.via;
            if (targets.has(edge.to)) {
                return firstVia;
            }
            if (!visited.has(edge.to)) {
                visited.add(edge.to);
                queue.push({ node: edge.to, firstVia });
            }
        }
    }
    return null;
}

/**
 * The routes a control opens onto, per the map: the destinations of edges the
 * crawl recorded `via` this control while actuating (kind "action"). A disclosure
 * — a sidebar group toggle, a menu opener — has no href of its own; clicking it
 * only reveals links, so the way to reach what it offers is to navigate to one of
 * these routes, not to click the control. Sorted shortest-first, so a group's
 * base/index route leads. Empty for an ordinary link or a control the crawl never
 * saw open anything. Matched by control identity (role|name), which is stable
 * across the pages that share the same persistent chrome (the sidebar).
 */
export function routesOpenedBy(graph: InteractionGraph, role: string, name: string): string[] {
    if (!name) {
        return [];
    }
    const routes = new Set<string>();
    for (const edge of graph.edges) {
        if (edge.via.kind !== "action" || edge.via.role !== role || edge.via.name !== name) {
            continue;
        }
        const to = graph.nodes[edge.to];
        if (to) {
            routes.add(to.url);
        }
    }
    return [...routes].sort((a, b) => a.length - b.length || a.localeCompare(b));
}

/**
 * Reach a target path the way a person would: by clicking the app's own
 * navigation rather than rewriting the URL. Each turn it first clicks a visible
 * link to the target, otherwise it clicks the control the interaction graph says
 * leads there (which opens a collapsed menu/group, revealing the link for the next
 * turn). Only when no in-app route can be found does it fall back to a direct URL
 * load — and the outcome says so, so a silent URL jump never masquerades as a
 * click in the recording or the manifest.
 */
export async function navigateLikeUser(
    page: Page,
    targetPath: string,
    graph: InteractionGraph,
    opts: NavigateOptions,
): Promise<NavOutcome> {
    const targetNorm = templated(targetPath, opts.baseUrl);
    let landed = templated(page.url(), opts.baseUrl);
    if (landed === targetNorm) {
        return { method: "already", ok: true, observation: `already at ${targetNorm}` };
    }

    await dismissOverlays(page);
    const trail: string[] = [];

    for (let hop = 0; hop < MAX_HOPS; hop++) {
        // A link straight to the target — the simplest user action, and what finishes a disclosure.
        const direct = await clickLiveLinkTo(page, targetPath, targetNorm, opts);
        if (direct) {
            trail.push(direct.name);
            const route = trail.join(" → ");
            const method = trail.length > 1 ? "click-path" : "click";
            if (direct.login) {
                return { method, ok: false, observation: `clicking ${route} dropped to login` };
            }
            if (direct.landed === targetNorm) {
                return { method, ok: true, observation: `clicked ${route} to open ${targetNorm}` };
            }
            if (direct.moved) {
                return { method, ok: true, observation: `clicked ${route}; landed at ${direct.landed}` };
            }
            // The click did nothing — drop it from the trail and let the map pick the next move.
            trail.pop();
        }

        // Otherwise click the control the map says leads toward the target (e.g. open a menu group).
        const via = nextControlToward(graph, landed, targetNorm);
        if (!via) {
            break;
        }
        const selectors = selectorsForVia(via);
        if (selectors.length === 0 || !(await clickBySelectors(page, selectors, opts.clickTimeoutMs))) {
            break;
        }
        trail.push(via.name || via.role);
        landed = await settle(page, opts);
        if (isLoginPath(page.url(), opts.loginPath)) {
            return {
                method: "click-path",
                ok: false,
                observation: `navigating via ${trail.join(" → ")} dropped to login`,
            };
        }
        if (landed === targetNorm) {
            return {
                method: "click-path",
                ok: true,
                observation: `navigated via ${trail.join(" → ")} to ${targetNorm}`,
            };
        }
    }

    // No in-app route found (or a click kept missing): load the URL so the test can still proceed.
    try {
        await page.goto(targetPath, { waitUntil: "domcontentloaded", timeout: opts.navTimeoutMs });
    } catch (error) {
        return {
            method: "goto",
            ok: false,
            observation: `could not reach ${targetNorm}: ${error instanceof Error ? error.message : String(error)}`,
        };
    }
    landed = await settle(page, opts);
    if (isLoginPath(page.url(), opts.loginPath)) {
        return { method: "goto", ok: false, observation: "redirected to login" };
    }
    return {
        method: "goto",
        ok: landed === targetNorm,
        observation: `no in-app link to ${targetNorm}; opened it directly`,
    };
}
