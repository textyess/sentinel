import * as fs from "node:fs";
import * as path from "node:path";
import type { ControlRef, InteractionGraph } from "../graph/types";
import type { ImportedIndex, SkillPackManifest } from "./types";

export interface LoadedSkills {
    /** Slugs of the skills selected for the requested routes (for traceability). */
    slugs: string[];
    /** Concatenated SKILL.md bodies (frontmatter stripped), ready to inject into a prompt. */
    text: string;
}

/** Prompt budget for the injected skills — kept in line with the diff excerpt's size. */
const MAX_SKILL_CHARS = 5000;

function skillsDir(outputDir: string, adapterId: string): string {
    return path.join(outputDir, adapterId, "skills");
}

function readJson<T>(file: string): T | null {
    if (!fs.existsSync(file)) {
        return null;
    }
    try {
        return JSON.parse(fs.readFileSync(file, "utf8")) as T;
    } catch {
        return null;
    }
}

/** Drop the leading YAML frontmatter block so only the prose body is injected. */
function stripFrontmatter(md: string): string {
    return md.replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
}

/** A route matches an indexed route when either is a path-prefix of the other. */
function routesOverlap(indexed: string, route: string): boolean {
    return indexed === route || indexed.startsWith(`${route}/`) || route.startsWith(`${indexed}/`);
}

/**
 * Select and read the navigation skills relevant to a set of affected routes, ready
 * to inject into the planning prompt. Reads both the generated pack (pack.json) and
 * any imported skills (imported.json), unioning matched area skills and appending
 * general skills last so the generals are dropped first if the character budget is
 * hit. Returns null when no skills exist at all — verify still runs without them.
 */
export function loadSkillsForRoutes(outputDir: string, adapterId: string, routes: string[]): LoadedSkills | null {
    const dir = skillsDir(outputDir, adapterId);

    const ordered: string[] = [];
    const seen = new Set<string>();
    const generals: string[] = [];
    const add = (slug: string): void => {
        if (slug && !seen.has(slug)) {
            seen.add(slug);
            ordered.push(slug);
        }
    };

    const pack = readJson<SkillPackManifest>(path.join(dir, "pack.json"));
    if (pack) {
        for (const route of routes) {
            for (const [indexed, slug] of Object.entries(pack.routeIndex)) {
                if (routesOverlap(indexed, route)) {
                    add(slug);
                }
            }
        }
        if (pack.general) {
            generals.push(pack.general);
        }
    }

    const imported = readJson<ImportedIndex>(path.join(dir, "imported.json"));
    if (imported) {
        for (const entry of imported.skills) {
            if (entry.general) {
                generals.push(entry.slug);
            } else if (routes.some((route) => entry.routes.some((r) => routesOverlap(r, route)))) {
                add(entry.slug);
            }
        }
    }

    for (const slug of generals) {
        add(slug);
    }

    const sections: string[] = [];
    const used: string[] = [];
    let budget = MAX_SKILL_CHARS;
    for (const slug of ordered) {
        const file = path.join(dir, slug, "SKILL.md");
        if (!fs.existsSync(file)) {
            continue;
        }
        let body: string;
        try {
            body = stripFrontmatter(fs.readFileSync(file, "utf8"));
        } catch {
            continue;
        }
        if (body.length === 0) {
            continue;
        }
        const section = `# Skill: ${slug}\n${body}`;
        if (section.length > budget) {
            // Keep a partial first-overflowing skill if there's meaningful room, then stop.
            if (budget > 200) {
                sections.push(`${section.slice(0, budget)}\n…(truncated)`);
                used.push(slug);
            }
            break;
        }
        sections.push(section);
        used.push(slug);
        budget -= section.length;
    }

    if (sections.length === 0) {
        return null;
    }
    return { slugs: used, text: sections.join("\n\n") };
}

/**
 * The execution-time skill for a single templated route: every control observed on
 * that page during the baseline crawl, verbatim, plus the owning skill slug for
 * provenance. Controls keep their `destructive` flag — this projection never filters
 * them, so the executor's existing destructive-block guard stays the single
 * enforcement point. `controls` come straight from the graph, never re-parsed from
 * SKILL.md prose, so the exact selectors/hrefs the crawl recorded stay exact.
 */
export interface PageSkill {
    /** Templated route this entry describes (a graph node `url`), e.g. "/campaigns/:id". */
    route: string;
    /** Owning skill slug, for traceability back to the pack. */
    skillSlug: string;
    /** Controls seen on this route, merged across page states, verbatim from the graph. */
    controls: ControlRef[];
}

/**
 * A route -> PageSkill lookup, scoped to the skills that own the affected routes. The
 * control data is the baseline graph's; pack.json/imported.json supply only route ->
 * slug ownership. Returned by {@link loadPageSkillIndex}, consumed by the executor.
 */
export interface PageSkillIndex {
    /** The page skill for a live templated route, or null when the route isn't covered. */
    get(route: string): PageSkill | null;
    /** Routes covered by the index, sorted — for logging/traceability. */
    routes: string[];
    /** Slugs that contributed at least one page, sorted — mirrors `skillsUsed`. */
    slugs: string[];
}

/**
 * Union the controls of every graph node sharing a templated route. Dedup is by full
 * control identity (role, name, href, kind, and the exact selector list), so only a
 * genuinely identical control seen on two page states collapses: two distinct nameless
 * controls (same role, empty name) keep their separate selectors, and a control whose
 * selectors shifted between states contributes both sets. Nothing recorded is dropped —
 * that is the point, since every selector widens the executor's self-heal candidate list.
 */
function mergeControlsForRoute(graph: InteractionGraph, route: string): ControlRef[] {
    const merged: ControlRef[] = [];
    const seen = new Set<string>();
    for (const node of Object.values(graph.nodes)) {
        if (node.url !== route) {
            continue;
        }
        for (const control of node.controls) {
            const key = JSON.stringify([control.role, control.name, control.href, control.kind, control.selectors]);
            if (seen.has(key)) {
                continue;
            }
            seen.add(key);
            merged.push(control);
        }
    }
    return merged;
}

/**
 * The routes each *selected* skill owns. A skill is selected when any route it owns
 * overlaps an affected route — the same scoping `loadSkillsForRoutes` uses, so the
 * executor sees skills for the same areas the planner did. Ownership comes from
 * pack.json (area slug -> routes) and imported.json (entry slug -> routes); general
 * skills own no page routes (they describe cross-area navigation, not page controls).
 *
 * Empty `affected` means the adapter could not map the diff to routes (e.g. a
 * component-only PR, or no `pagesPrefix` configured). Rather than go inert, select EVERY
 * skill so the index covers the whole app — the executor then gets selector-first
 * execution + drift detection for whatever routes the run actually walks, mirroring how
 * the planner still loads the general skill when there are no affected routes.
 */
function ownedRoutesBySelectedSkill(
    pack: SkillPackManifest | null,
    imported: ImportedIndex | null,
    affected: string[],
): Map<string, Set<string>> {
    const bySlug = new Map<string, Set<string>>();
    const select = (slug: string, owns: string[]): void => {
        const selected =
            affected.length === 0 || owns.some((owned) => affected.some((route) => routesOverlap(owned, route)));
        if (!selected) {
            return;
        }
        const set = bySlug.get(slug) ?? new Set<string>();
        for (const route of owns) {
            set.add(route);
        }
        bySlug.set(slug, set);
    };

    if (pack) {
        for (const area of pack.areas) {
            select(area.slug, area.routes);
        }
    }
    if (imported) {
        for (const entry of imported.skills) {
            if (!entry.general) {
                select(entry.slug, entry.routes);
            }
        }
    }
    return bySlug;
}

/**
 * Build a per-route page-skill lookup for the executor: for each affected area, the
 * exact controls (selectors, hrefs, destructive flags) the baseline crawl recorded on
 * each of its routes. The graph supplies the control data verbatim; pack.json /
 * imported.json supply only route -> owning-skill provenance. When `routes` is empty
 * (the adapter mapped the diff to nothing) the index covers the WHOLE app instead of
 * going inert. Returns null only when no skill pack exists, or when nothing the pack
 * owns has a matching graph node — so this is a pure, additive enrichment that activates
 * once `sentinel skills` has run.
 */
export function loadPageSkillIndex(
    outputDir: string,
    adapterId: string,
    graph: InteractionGraph,
    routes: string[],
): PageSkillIndex | null {
    const dir = skillsDir(outputDir, adapterId);
    const pack = readJson<SkillPackManifest>(path.join(dir, "pack.json"));
    const imported = readJson<ImportedIndex>(path.join(dir, "imported.json"));
    if (!pack && !imported) {
        return null;
    }

    const bySlug = ownedRoutesBySelectedSkill(pack, imported, routes);

    // Project each owned route onto the graph's controls. A route with no matching
    // node (e.g. an imported skill from another app) is skipped — the index only
    // carries pages we have exact control data for. When a route is owned by more than
    // one skill the first writer wins: pack areas are inserted before imported skills
    // (see ownedRoutesBySelectedSkill), so a shared route is attributed to the locally
    // generated pack, never to an import. Only the `skillSlug` provenance differs; the
    // controls come from the graph and are identical whichever skill owns the route.
    const entries = new Map<string, PageSkill>();
    for (const [slug, owned] of bySlug) {
        for (const route of owned) {
            if (entries.has(route)) {
                continue;
            }
            const controls = mergeControlsForRoute(graph, route);
            if (controls.length === 0) {
                continue;
            }
            entries.set(route, { route, skillSlug: slug, controls });
        }
    }

    if (entries.size === 0) {
        return null;
    }

    const coveredRoutes = Array.from(entries.keys()).sort();
    const slugs = Array.from(new Set(Array.from(entries.values(), (entry) => entry.skillSlug))).sort();
    return {
        get: (route: string) => entries.get(route) ?? null,
        routes: coveredRoutes,
        slugs,
    };
}
