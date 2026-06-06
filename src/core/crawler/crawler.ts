import * as fs from "node:fs";
import * as path from "node:path";
import type { DriverSession } from "../browser/driver";
import { dismissOverlays, extractControls, stateSignature, waitForInteractive } from "../graph/extract";
import type { ControlRef, CoverageReport, EdgeVia, GraphEdge, InteractionGraph, PageNode } from "../graph/types";
import { isLoginPath, normalizePath } from "../graph/url";
import type { PacingOptions } from "../human/pacing";
import { logger } from "../logger";
import type { Reasoner } from "../reasoner/types";
import type { RepoAdapter } from "../types";
import { actuateForDiscovery } from "./actuate";

export interface CrawlOptions {
    /** Hard cap on unique page states mapped, so a crawl always terminates. */
    maxPages: number;
    /** How long to wait for interactive content to render and settle after each navigation. */
    settleMs: number;
    navTimeoutMs: number;
    screenshot: boolean;
    /** Absolute dir where screenshots are written; the graph stores them as relative paths. */
    screenshotDir: string;
    gitSha: string | null;
    /** When true (and a reasoner is set), click expanders/tabs/menus to reveal more navigation. */
    interact: boolean;
    /** The reasoning layer used for actuation decisions; null disables actuation. */
    reasoner: Reasoner | null;
    /** Max controls actuated per page during interaction. */
    actuationsPerPage: number;
    pacing: PacingOptions;
}

interface QueueItem {
    /** The raw path to navigate to. */
    path: string;
    /** Normalized path of the originating seed, if this item came from the seed list. */
    seedOrigin: string | null;
}

/** A navigation edge whose target node is resolved after the crawl, once every path has a node id. */
interface PendingEdge {
    from: string;
    via: EdgeVia;
    childNorm: string;
}

/**
 * A bounded breadth-first crawl that follows internal navigation links. Each
 * unique page state becomes a node carrying the full catalogue of its interactive
 * controls (with ranked selectors and a destructive flag); navigation between
 * pages becomes edges. Dynamic routes collapse via path templating so the crawl
 * always terminates. Destructive links are recorded but never followed, and
 * non-navigation controls are catalogued but not yet actuated — that interaction
 * probing (clicking expanders/tabs to reveal more) is the next increment.
 */
export async function crawl(
    session: DriverSession,
    adapter: RepoAdapter,
    options: CrawlOptions,
): Promise<InteractionGraph> {
    const { baseUrl } = adapter;
    const { page } = session;
    const destructive = adapter.safety.destructiveControlPatterns.map((p) => new RegExp(p, "i"));

    const nodes: Record<string, PageNode> = {};
    const pendingEdges: PendingEdge[] = [];
    const pathToNode = new Map<string, string>();
    const queuedPaths = new Set<string>();
    const seedReached = new Set<string>();
    const actuated = new Set<string>();
    // Control identities (role|name) already actuated anywhere — persistent chrome (sidebar/topbar)
    // is identical on every page, so this keeps it from being re-clicked once per node.
    const seenControls = new Set<string>();
    const errors: string[] = [];

    const queue: QueueItem[] = [];
    // Always seed the app root so a project with no explicit knownRoutes (e.g. a public
    // app registered without auto-detect) still has an entry point; the breadth-first
    // crawl discovers the rest by following internal links from there.
    for (const route of ["/", ...adapter.knownRoutes]) {
        const norm = normalizePath(route, baseUrl).path;
        if (!queuedPaths.has(norm)) {
            queuedPaths.add(norm);
            queue.push({ path: route, seedOrigin: norm });
        }
    }

    while (queue.length > 0 && Object.keys(nodes).length < options.maxPages) {
        const item = queue.shift();
        if (!item) {
            break;
        }

        let landedUrl: string;
        try {
            await page.goto(item.path, { waitUntil: "domcontentloaded", timeout: options.navTimeoutMs });
            await waitForInteractive(page, options.settleMs);
            landedUrl = page.url();
        } catch (error) {
            errors.push(`goto ${item.path}: ${error instanceof Error ? error.message : String(error)}`);
            continue;
        }

        if (isLoginPath(landedUrl, adapter.auth.loginPath)) {
            errors.push(`auth wall: ${item.path} redirected to login`);
            continue;
        }

        await dismissOverlays(page);
        const landed = normalizePath(landedUrl, baseUrl);
        const title = await page.title().catch(() => "");
        const controls = await extractControls(page, destructive, baseUrl).catch((): ControlRef[] => []);
        const signature = stateSignature(landed.path, controls);

        if (!nodes[signature]) {
            nodes[signature] = await buildNode(page, signature, landed, landedUrl, title, controls, options);
            pathToNode.set(landed.path, signature);
            logger.info(
                `mapped ${landed.path}  (${controls.length} controls)  [${Object.keys(nodes).length}/${options.maxPages}]`,
            );
        }
        // The seed is "reached" whenever its navigation resolved to a mapped node — even via a redirect.
        if (item.seedOrigin) {
            seedReached.add(item.seedOrigin);
        }

        const enqueueChild = (href: string, via: EdgeVia): void => {
            const childNorm = normalizePath(href, baseUrl).path;
            pendingEdges.push({ from: signature, via, childNorm });
            if (!queuedPaths.has(childNorm)) {
                queuedPaths.add(childNorm);
                queue.push({ path: href, seedOrigin: null });
            }
        };

        for (const control of controls) {
            if (control.kind !== "navigation" || !control.href) {
                continue;
            }
            // Never navigate a destructive link (e.g. logout, unsubscribe, a GET soft-delete):
            // GET navigations bypass the read-only guard, so this is the only line of defense.
            if (control.destructive || destructive.some((re) => re.test(control.href ?? ""))) {
                continue;
            }
            enqueueChild(control.href, {
                role: control.role,
                name: control.name,
                selector: control.selectors[0] ?? "",
                kind: control.kind,
            });
        }

        // LLM-guided actuation: click expanders/tabs/menus to reveal navigation the
        // static <a href> crawl can't see (e.g. collapsed sidebar groups).
        const node = nodes[signature];
        if (options.interact && options.reasoner && node && !actuated.has(signature)) {
            actuated.add(signature);
            const discovered = await actuateForDiscovery(page, node, controls, {
                reasoner: options.reasoner,
                destructive,
                baseUrl,
                loginPath: adapter.auth.loginPath,
                seenControls,
                pacing: options.pacing,
                actuationsPerPage: options.actuationsPerPage,
                maxCandidates: 25,
                settleMs: options.settleMs,
                navTimeoutMs: options.navTimeoutMs,
                clickTimeoutMs: 8000,
            });
            for (const link of discovered) {
                if (!destructive.some((re) => re.test(link.href))) {
                    enqueueChild(link.href, link.via);
                }
            }
        }
    }

    // Resolve every recorded navigation to its (now-known) target node, then dedupe.
    const edges = dedupeEdges(
        pendingEdges.flatMap((pending): GraphEdge[] => {
            const to = pathToNode.get(pending.childNorm);
            return to ? [{ from: pending.from, to, via: pending.via, transition: "navigate" }] : [];
        }),
    );

    const coverage = buildCoverage(adapter, nodes, seedReached, edges, session, errors, options, queue.length);

    return {
        repoId: adapter.id,
        baseUrl,
        gitSha: options.gitSha,
        createdAt: new Date().toISOString(),
        nodes,
        edges,
        coverage,
    };
}

async function buildNode(
    page: DriverSession["page"],
    signature: string,
    landed: { path: string; area: string | null },
    rawUrl: string,
    title: string,
    controls: ControlRef[],
    options: CrawlOptions,
): Promise<PageNode> {
    let screenshot: string | null = null;
    if (options.screenshot) {
        try {
            fs.mkdirSync(options.screenshotDir, { recursive: true });
            await page.screenshot({ path: path.join(options.screenshotDir, `${signature}.png`) });
            // Store a path relative to the graph dir so the artifact is portable.
            screenshot = path.join("screenshots", `${signature}.png`);
        } catch {
            // A screenshot failure must not abort the crawl.
        }
    }

    const flagged: string[] = [];
    if (controls.length === 0) {
        const hasCanvas = await page.evaluate("!!document.querySelector('canvas')").catch(() => false);
        flagged.push(hasCanvas ? "opaque-canvas" : "no-interactive-controls");
    }

    return {
        id: signature,
        url: landed.path,
        rawUrlSample: rawUrl,
        title,
        routeArea: landed.area,
        controlCount: controls.length,
        controls,
        screenshot,
        visitedAt: new Date().toISOString(),
        flagged,
    };
}

function dedupeEdges(edges: GraphEdge[]): GraphEdge[] {
    const seen = new Set<string>();
    const out: GraphEdge[] = [];
    for (const edge of edges) {
        const key = `${edge.from}->${edge.to}|${edge.via.name}|${edge.transition}`;
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        out.push(edge);
    }
    return out;
}

function buildCoverage(
    adapter: RepoAdapter,
    nodes: Record<string, PageNode>,
    seedReached: Set<string>,
    edges: GraphEdge[],
    session: DriverSession,
    errors: string[],
    options: CrawlOptions,
    remaining: number,
): CoverageReport {
    const seeded = adapter.knownRoutes.map((route) => normalizePath(route, adapter.baseUrl).path);
    const uniqueSeeded = Array.from(new Set(seeded));
    const areas = new Set<string>();
    for (const node of Object.values(nodes)) {
        if (node.routeArea) {
            areas.add(node.routeArea);
        }
    }
    const nodeCount = Object.keys(nodes).length;
    const notes = [...errors];
    notes.push(
        `Discovered ${nodeCount} page state(s); ${seedReached.size}/${uniqueSeeded.length} seeded routes reached.`,
    );
    if (remaining > 0) {
        notes.push(`Stopped at maxPages=${options.maxPages}; ${remaining} path(s) still queued.`);
    }
    return {
        routesSeeded: uniqueSeeded,
        routesReached: uniqueSeeded.filter((p) => seedReached.has(p)),
        routesUnreached: uniqueSeeded.filter((p) => !seedReached.has(p)),
        areasReached: Array.from(areas).sort(),
        nodeCount,
        edgeCount: edges.length,
        blockedWrites: session.blocked.filter((b) => b.reason === "mutation").length,
        notes,
    };
}
