import * as fs from "node:fs";
import * as path from "node:path";
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
