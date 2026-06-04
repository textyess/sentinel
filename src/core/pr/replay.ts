import * as fs from "node:fs";
import * as path from "node:path";
import type { DriverSession } from "../browser/driver";
import { dismissOverlays, extractControls, waitForInteractive } from "../graph/extract";
import type { ControlRef, InteractionGraph, PageNode } from "../graph/types";
import { isLoginPath, pathnameOf, stripQuery } from "../graph/url";
import { humanDwell, type PacingOptions, thinkPause } from "../human/pacing";
import { logger } from "../logger";
import type { FlowResult } from "./types";

export interface ReplayOptions {
    settleMs: number;
    navTimeoutMs: number;
    screenshotDir: string;
    destructive: RegExp[];
    loginPath: string;
    pacing: PacingOptions;
}

/** Pick the baseline nodes to re-walk for a PR: those under the affected routes, with /home as a smoke anchor. */
export function selectFlows(graph: InteractionGraph, affectedRoutes: string[], maxFlows: number): PageNode[] {
    // Dynamic-id nodes (/flows/:id) carry a stale prod id that won't resolve on the preview — skip them
    // in navigation-only replay; a fresh-id actuation pass is the way to cover detail pages later.
    const nodes = Object.values(graph.nodes).filter((n) => !n.url.includes(":id"));
    const home = nodes.find((n) => n.url === "/home");
    const matched =
        affectedRoutes.length > 0
            ? nodes.filter((n) =>
                  affectedRoutes.some(
                      (r) => n.url === r || n.url.startsWith(`${r}/`) || n.routeArea === r.replace(/^\//, ""),
                  ),
              )
            : [];

    const ordered: PageNode[] = [];
    const seen = new Set<string>();
    const add = (node?: PageNode): void => {
        if (node && !seen.has(node.id)) {
            seen.add(node.id);
            ordered.push(node);
        }
    };
    add(home);
    for (const node of matched) {
        add(node);
    }
    // Nothing matched beyond the anchor — replay a STABLE smoke spread (shallow, top-level routes first).
    if (ordered.length <= 1) {
        const spread = [...nodes].sort(
            (a, b) => a.url.split("/").length - b.url.split("/").length || a.url.localeCompare(b.url),
        );
        for (const node of spread) {
            add(node);
        }
    }
    return ordered.slice(0, maxFlows);
}

/** Control identity for diffing, normalized so per-record data churn (counts, names) doesn't register as a UI change. */
function controlNames(controls: ControlRef[]): Set<string> {
    const set = new Set<string>();
    for (const control of controls) {
        if (control.name) {
            set.add(`${control.role}:${control.name.toLowerCase().replace(/\d+/g, "#")}`);
        }
    }
    return set;
}

/**
 * Re-walk each baseline flow against the PR target, recording what changed: console
 * errors, failed network calls, blocked writes, and which controls disappeared or
 * appeared versus the Phase 1 baseline. The whole run is captured as one video.
 */
export async function replayFlows(
    session: DriverSession,
    baselineNodes: PageNode[],
    options: ReplayOptions,
): Promise<FlowResult[]> {
    const results: FlowResult[] = [];

    for (const node of baselineNodes) {
        // node.url is the clean normalized path (dynamic-id nodes were filtered out in selectFlows).
        const targetPath = node.url;
        const consoleBefore = session.consoleErrors.length;
        const networkBefore = session.network.length;
        const blockedBefore = session.blocked.filter((b) => b.reason === "mutation").length;

        let reached = true;
        let note: string | null = null;
        try {
            await thinkPause(session.page, options.pacing);
            await session.page.goto(targetPath, { waitUntil: "domcontentloaded", timeout: options.navTimeoutMs });
            await waitForInteractive(session.page, options.settleMs);
        } catch (error) {
            reached = false;
            note = `goto failed: ${error instanceof Error ? error.message : String(error)}`;
        }
        if (reached && isLoginPath(session.page.url(), options.loginPath)) {
            reached = false;
            note = "redirected to login (auth wall / session lost)";
        }

        let controlDiff = { missing: [] as string[], added: [] as string[] };
        let screenshot: string | null = null;
        if (reached) {
            await dismissOverlays(session.page);
            // Spend time proportional to the page's content — scroll + read like a human.
            await humanDwell(session.page, options.pacing);
            const controls = await extractControls(session.page, options.destructive, session.baseUrl).catch(
                (): ControlRef[] => [],
            );
            const baseNames = controlNames(node.controls);
            const nowNames = controlNames(controls);
            controlDiff = {
                missing: [...baseNames].filter((n) => !nowNames.has(n)),
                added: [...nowNames].filter((n) => !baseNames.has(n)),
            };
            try {
                fs.mkdirSync(options.screenshotDir, { recursive: true });
                await session.page.screenshot({ path: path.join(options.screenshotDir, `${node.id}.png`) });
                screenshot = path.join("screenshots", `${node.id}.png`);
            } catch {
                // A screenshot failure must not abort the replay.
            }
        }

        const networkErrors = session.network
            .slice(networkBefore)
            // 423 is Sentinel's own read-only guard fulfilling a blocked write — not an app error.
            .filter((e) => e.status >= 400 && e.status !== 423)
            // Strip the query string so one-time tokens never enter the manifest.
            .map((e) => ({ url: stripQuery(e.url), status: e.status }));
        const consoleErrors = session.consoleErrors.slice(consoleBefore);
        const blockedWrites = session.blocked.filter((b) => b.reason === "mutation").length - blockedBefore;

        results.push({
            url: node.url,
            routeArea: node.routeArea,
            reached,
            screenshot,
            consoleErrors,
            networkErrors,
            blockedWrites,
            controlDiff,
            note,
        });

        const flags = [
            reached ? "" : "UNREACHED",
            consoleErrors.length ? `${consoleErrors.length} console-err` : "",
            networkErrors.length ? `${networkErrors.length} net-err` : "",
            controlDiff.missing.length || controlDiff.added.length
                ? `controls -${controlDiff.missing.length}/+${controlDiff.added.length}`
                : "",
        ]
            .filter(Boolean)
            .join(", ");
        logger.info(`replayed ${node.url}${flags ? `  [${flags}]` : "  ok"}`);
    }

    return results;
}
