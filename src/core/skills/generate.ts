import * as fs from "node:fs";
import * as path from "node:path";
import { graphScreenshotDir } from "../graph/store";
import type { InteractionGraph } from "../graph/types";
import { logger } from "../logger";
import type { Reasoner } from "../reasoner/types";
import { redactSecret } from "../safety/redact";
import { authorAreaSkill, authorGeneralSkill } from "./author";
import { serializeFrontmatter } from "./frontmatter";
import type { AreaSlice } from "./group";
import { groupByArea } from "./group";
import type { SkillDoc, SkillFrontmatter, SkillPack, SkillPackManifest } from "./types";

/** Reduce an area name to a path/name-safe slug component. */
function slugifyArea(area: string): string {
    return area
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
}

/** Skill folder/name for an area; the rootless bucket becomes "<app>-root". */
function areaSlug(adapterId: string, area: string | null): string {
    const safeArea = area ? slugifyArea(area) : "root";
    return `${adapterId}-${safeArea || "root"}`;
}

function navigationSlug(adapterId: string): string {
    return `${adapterId}-navigation`;
}

/** Keep a route list short enough for a one-line description. */
function truncateRoutes(routes: string[], cap: number): string {
    return routes.length <= cap ? routes.join(", ") : `${routes.slice(0, cap).join(", ")}, …`;
}

function areaFrontmatter(graph: InteractionGraph, adapterId: string, slice: AreaSlice): SkillFrontmatter {
    const label = slice.area ?? "top-level";
    return {
        name: areaSlug(adapterId, slice.area),
        description: `Navigate the ${label} area of ${graph.repoId} (routes: ${truncateRoutes(slice.routes, 6)}). Load when working in ${label}.`,
        metadata: {
            source: graph.repoId,
            baseUrl: graph.baseUrl,
            gitSha: graph.gitSha,
            area: slice.area,
            routes: slice.routes,
            createdAt: graph.createdAt,
        },
    };
}

function generalFrontmatter(graph: InteractionGraph, adapterId: string, slices: AreaSlice[]): SkillFrontmatter {
    const areaNames = slices.map((s) => s.area ?? "top-level").join(", ");
    const entry = Array.from(new Set(slices.flatMap((s) => s.entryRoutes)));
    return {
        name: navigationSlug(adapterId),
        description: `Navigate the ${graph.repoId} web app — overall structure, areas (${areaNames}), auth, and how to move between sections. Load before driving ${graph.repoId}.`,
        metadata: {
            source: graph.repoId,
            baseUrl: graph.baseUrl,
            gitSha: graph.gitSha,
            area: null,
            routes: entry,
            createdAt: graph.createdAt,
        },
    };
}

function screenshotsFor(slice: AreaSlice): string[] {
    const out: string[] = [];
    for (const node of slice.nodes) {
        if (node.screenshot) {
            out.push(node.screenshot);
        }
    }
    return out;
}

/** Bundle a skill's screenshots into its folder so the skill is portable. Best-effort. */
function copyScreenshots(doc: SkillDoc, sourceShotDir: string, skillDir: string): void {
    if (doc.screenshots.length === 0) {
        return;
    }
    const destDir = path.join(skillDir, "screenshots");
    for (const rel of doc.screenshots) {
        const name = path.basename(rel);
        const source = path.join(sourceShotDir, name);
        if (!fs.existsSync(source)) {
            continue;
        }
        try {
            fs.mkdirSync(destDir, { recursive: true });
            fs.copyFileSync(source, path.join(destDir, name));
        } catch {
            // A screenshot copy failure must not abort skill generation.
        }
    }
}

function buildManifest(graph: InteractionGraph, adapterId: string, slices: AreaSlice[]): SkillPackManifest {
    const routeIndex: Record<string, string> = {};
    for (const slice of slices) {
        const slug = areaSlug(adapterId, slice.area);
        for (const route of slice.routes) {
            routeIndex[route] = slug;
        }
    }
    return {
        source: graph.repoId,
        baseUrl: graph.baseUrl,
        gitSha: graph.gitSha,
        createdAt: graph.createdAt,
        general: navigationSlug(adapterId),
        areas: slices.map((slice) => ({
            area: slice.area,
            slug: areaSlug(adapterId, slice.area),
            routes: slice.routes,
        })),
        routeIndex,
    };
}

export interface GenerateSkillPackArgs {
    graph: InteractionGraph;
    outputDir: string;
    /** The adapter / repo id — prefixes every skill name so packs stay unique when shared. */
    adapterId: string;
    /** Required: every skill body is LLM-authored and graph-verified. */
    reasoner: Reasoner;
}

/**
 * Project the latest interaction graph into a navigation skill pack on disk. Pure
 * over the graph — no browsing. Each skill body is fully LLM-authored from the
 * observed interaction data and verified against the graph (with bounded repair-retry)
 * before it is written. Every file is redacted before it touches disk, since the pack
 * is a shareable artifact.
 */
export async function generateSkillPack(args: GenerateSkillPackArgs): Promise<SkillPack> {
    const { graph, outputDir, adapterId, reasoner } = args;
    const slices = groupByArea(graph);

    const slugs = new Map<string | null, string>();
    for (const slice of slices) {
        slugs.set(slice.area, areaSlug(adapterId, slice.area));
    }

    const docs: SkillDoc[] = [];
    for (const slice of slices) {
        const slug = areaSlug(adapterId, slice.area);
        logger.info(`Authoring ${slug} (${slice.nodes.length} page(s)) ...`);
        docs.push({
            slug,
            frontmatter: areaFrontmatter(graph, adapterId, slice),
            body: await authorAreaSkill(reasoner, slug, slice, graph),
            screenshots: screenshotsFor(slice),
        });
    }

    const generalSlug = navigationSlug(adapterId);
    logger.info(`Authoring ${generalSlug} (general navigation) ...`);
    docs.push({
        slug: generalSlug,
        frontmatter: generalFrontmatter(graph, adapterId, slices),
        body: await authorGeneralSkill(reasoner, generalSlug, graph, slices, slugs),
        screenshots: [],
    });

    const dir = path.join(outputDir, adapterId, "skills");
    fs.mkdirSync(dir, { recursive: true });
    const sourceShotDir = graphScreenshotDir(outputDir, adapterId);

    for (const doc of docs) {
        const skillDir = path.join(dir, doc.slug);
        fs.mkdirSync(skillDir, { recursive: true });
        const content = `${serializeFrontmatter(doc.frontmatter)}\n\n${doc.body}\n`;
        fs.writeFileSync(path.join(skillDir, "SKILL.md"), redactSecret(content));
        copyScreenshots(doc, sourceShotDir, skillDir);
    }

    const manifest = buildManifest(graph, adapterId, slices);
    fs.writeFileSync(path.join(dir, "pack.json"), redactSecret(JSON.stringify(manifest, null, 2)));

    return { dir, manifest, skillCount: docs.length };
}
