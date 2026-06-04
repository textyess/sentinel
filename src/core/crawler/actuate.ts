import type { Page } from "playwright";
import { z } from "zod";
import { clickBySelectors } from "../browser/interact";
import { extractControls, waitForInteractive } from "../graph/extract";
import type { ControlRef, EdgeVia, PageNode } from "../graph/types";
import { isLoginPath, pathnameOf, resolveInternalPath, stripQuery } from "../graph/url";
import { type PacingOptions, thinkPause } from "../human/pacing";
import { logger } from "../logger";
import type { Reasoner } from "../reasoner/types";

export interface DiscoveredLink {
    href: string;
    via: EdgeVia;
}

export interface ActuateOptions {
    reasoner: Reasoner;
    destructive: RegExp[];
    baseUrl: string;
    /** Login path, so actuation can detect (and stop on) a mid-crawl session loss. */
    loginPath: string;
    /** Crawl-level set of already-actuated control identities (role|name) — persistent chrome (the
     * sidebar) is identical on every page, so this stops re-classifying/clicking it ~once per page. */
    seenControls: Set<string>;
    pacing: PacingOptions;
    /** Max controls actuated per page. */
    actuationsPerPage: number;
    /** Max controls shown to the model (bounds prompt size). */
    maxCandidates: number;
    settleMs: number;
    navTimeoutMs: number;
    clickTimeoutMs: number;
}

const DECISION_SCHEMA = z.object({
    decisions: z.array(
        z.object({
            index: z.number().int(),
            intent: z.enum(["expand", "tab", "navigate", "skip"]),
        }),
    ),
});

const CLASSIFY_SYSTEM =
    "You help a READ-ONLY web crawler discover more of an app's pages and navigation. " +
    "Given a page's clickable controls, decide which to click to reveal more navigation: " +
    "expanders/menu-openers (expand), in-page tab switches (tab), or controls that go to another page (navigate); " +
    "skip everything else. ALWAYS skip anything that submits a form, creates/sends/deletes/pays, logs out, or " +
    "triggers a one-off action. Prefer sidebar group toggles, 'view all', tabs, and menu openers.";

function controlKey(control: ControlRef): string {
    return `${control.role}|${control.name}`;
}

async function classifyControls(reasoner: Reasoner, node: PageNode, candidates: ControlRef[]): Promise<Set<number>> {
    const list = candidates.map((control, index) => `${index}. [${control.role}] "${control.name}"`).join("\n");
    const prompt = `Page ${node.url}${node.title ? ` (${node.title})` : ""}. Clickable controls:\n${list}\n\nClassify each control by its index.`;
    try {
        const result = await reasoner.generateObject({
            prompt,
            system: CLASSIFY_SYSTEM,
            schema: DECISION_SCHEMA,
            maxTokens: 1500,
            telemetryLabel: "actuate-classify",
        });
        const keep = new Set<number>();
        for (const decision of result.decisions) {
            if (decision.intent !== "skip" && decision.index >= 0 && decision.index < candidates.length) {
                keep.add(decision.index);
            }
        }
        return keep;
    } catch (error) {
        logger.warn(`actuation: classify failed (${error instanceof Error ? error.message : String(error)})`);
        return new Set();
    }
}

/**
 * Click the model-chosen non-destructive controls (expanders, tabs, menus) and
 * harvest navigation they reveal — the links a pure <a href> crawl can't see
 * because they live behind collapsed groups. Each actuation (after the first)
 * restores to the page first, so clicks never compound; persistent chrome is
 * actuated only once across the whole crawl; and a click that drops the session
 * (lands on /login) stops actuation rather than corrupting the graph.
 */
export async function actuateForDiscovery(
    page: Page,
    node: PageNode,
    controls: ControlRef[],
    options: ActuateOptions,
): Promise<DiscoveredLink[]> {
    const candidates = controls
        .filter((c) => c.kind === "action" && !c.destructive && c.selectors.length > 0 && c.name)
        .filter((c) => !options.seenControls.has(controlKey(c)))
        .slice(0, options.maxCandidates);
    if (candidates.length === 0) {
        return [];
    }

    const keep = await classifyControls(options.reasoner, node, candidates);
    const toClick = candidates.filter((_, index) => keep.has(index)).slice(0, options.actuationsPerPage);
    if (toClick.length === 0) {
        return [];
    }

    const restoreUrl = stripQuery(node.rawUrlSample);
    const knownHrefs = new Set(controls.filter((c) => c.kind === "navigation" && c.href).map((c) => c.href as string));
    const discovered: DiscoveredLink[] = [];
    // The crawler has just navigated here, so the first actuation needs no restore.
    let dirtied = false;

    for (const control of toClick) {
        options.seenControls.add(controlKey(control));

        if (dirtied) {
            try {
                await page.goto(restoreUrl, { waitUntil: "domcontentloaded", timeout: options.navTimeoutMs });
                await waitForInteractive(page, options.settleMs);
            } catch {
                continue;
            }
        }
        if (isLoginPath(page.url(), options.loginPath)) {
            return discovered;
        }

        const beforePath = pathnameOf(page.url());
        await thinkPause(page, options.pacing);
        const clicked = await clickBySelectors(page, control.selectors, options.clickTimeoutMs);
        dirtied = true;
        if (!clicked) {
            continue;
        }
        await waitForInteractive(page, options.settleMs);

        const afterUrl = page.url();
        if (isLoginPath(afterUrl, options.loginPath)) {
            return discovered;
        }

        const via: EdgeVia = {
            role: control.role,
            name: control.name,
            selector: control.selectors[0] ?? "",
            kind: "action",
        };

        if (pathnameOf(afterUrl) !== beforePath) {
            // The control navigated to a different page.
            const internal = resolveInternalPath(afterUrl, options.baseUrl);
            if (internal && internal !== node.url && !knownHrefs.has(internal)) {
                discovered.push({ href: internal, via });
                knownHrefs.add(internal);
            }
            continue;
        }

        // Additive (expander/tab/menu, including a query-only view change): harvest revealed links.
        const revealed = await extractControls(page, options.destructive, options.baseUrl).catch(
            (): ControlRef[] => [],
        );
        for (const link of revealed) {
            if (
                link.kind === "navigation" &&
                link.href &&
                !link.destructive &&
                link.href !== node.url &&
                !knownHrefs.has(link.href)
            ) {
                discovered.push({ href: link.href, via });
                knownHrefs.add(link.href);
            }
        }
    }

    if (discovered.length > 0) {
        logger.info(`  actuation revealed ${discovered.length} new link(s) on ${node.url}`);
    }
    return discovered;
}
