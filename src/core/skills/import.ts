import * as fs from "node:fs";
import * as path from "node:path";
import { logger } from "../logger";
import { redactSecret } from "../safety/redact";
import { serializeFrontmatter } from "./frontmatter";
import type { ImportedIndex, ImportedSkillEntry, SkillFrontmatter } from "./types";

export interface ImportSkillPackArgs {
    outputDir: string;
    adapterId: string;
    /** Directory holding the skill folder(s) to import. */
    sourceDir: string;
    /** Overwrite skills that already exist in the destination. */
    overwrite: boolean;
}

export interface ImportResult {
    installed: string[];
    skipped: string[];
    total: number;
}

interface ParsedFrontmatter {
    name?: string;
    description?: string;
    area?: string | null;
    routes?: string[];
    source?: string;
    baseUrl?: string;
    gitSha?: string | null;
    createdAt?: string;
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg)$/i;

function parseScalar(raw: string): string {
    const trimmed = raw.trim();
    if (trimmed.startsWith('"')) {
        try {
            return JSON.parse(trimmed) as string;
        } catch {
            return trimmed.replace(/^"|"$/g, "");
        }
    }
    return trimmed;
}

function parseArray(raw: string): string[] {
    const trimmed = raw.trim();
    if (trimmed.startsWith("[")) {
        try {
            const parsed = JSON.parse(trimmed);
            return Array.isArray(parsed) ? parsed.map(String) : [];
        } catch {
            return [];
        }
    }
    return trimmed ? [trimmed] : [];
}

/**
 * Minimal frontmatter reader for the fields we care about (name, description, and the
 * metadata block). Tolerant of both our JSON-quoted output and plain YAML scalars.
 * Anything else in the frontmatter (e.g. an `allowed-tools` capability grant) is
 * ignored — it never reaches the re-serialized skill.
 */
function parseFrontmatter(md: string): ParsedFrontmatter {
    const match = md.match(/^---\n([\s\S]*?)\n---/);
    const out: ParsedFrontmatter = {};
    const block = match?.[1];
    if (!block) {
        return out;
    }
    let inMeta = false;
    for (const line of block.split("\n")) {
        if (/^\S/.test(line)) {
            inMeta = line.trim() === "metadata:";
            const top = line.match(/^([A-Za-z_]+):\s*(.*)$/);
            const key = top?.[1];
            if (key === "name") {
                out.name = parseScalar(top?.[2] ?? "");
            } else if (key === "description") {
                out.description = parseScalar(top?.[2] ?? "");
            }
            continue;
        }
        if (!inMeta) {
            continue;
        }
        const meta = line.match(/^\s+([A-Za-z_]+):\s*(.*)$/);
        const key = meta?.[1];
        const value = meta?.[2] ?? "";
        if (key === "routes") {
            out.routes = parseArray(value);
        } else if (key === "area") {
            out.area = value.trim() === "null" ? null : parseScalar(value);
        } else if (key === "source") {
            out.source = parseScalar(value);
        } else if (key === "baseUrl") {
            out.baseUrl = parseScalar(value);
        } else if (key === "gitSha") {
            out.gitSha = value.trim() === "null" ? null : parseScalar(value);
        } else if (key === "createdAt") {
            out.createdAt = parseScalar(value);
        }
    }
    return out;
}

function slugify(value: string): string {
    return value
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, "-")
        .replace(/^-+|-+$/g, "");
}

/** Locate the skill folders under a source dir (or treat the dir itself as one skill). */
function findSkillDirs(sourceDir: string): string[] {
    if (fs.existsSync(path.join(sourceDir, "SKILL.md"))) {
        return [sourceDir];
    }
    const dirs: string[] = [];
    for (const entry of fs.readdirSync(sourceDir)) {
        const full = path.join(sourceDir, entry);
        if (fs.statSync(full).isDirectory() && fs.existsSync(path.join(full, "SKILL.md"))) {
            dirs.push(full);
        }
    }
    return dirs;
}

/** Copy only image assets from a source skill's screenshots/ — never scripts or other files. */
function copyImages(srcSkillDir: string, destSkillDir: string): void {
    const srcShots = path.join(srcSkillDir, "screenshots");
    if (!fs.existsSync(srcShots)) {
        return;
    }
    const dest = path.join(destSkillDir, "screenshots");
    for (const entry of fs.readdirSync(srcShots)) {
        if (!IMAGE_EXT.test(entry)) {
            continue;
        }
        const source = path.join(srcShots, entry);
        if (!fs.statSync(source).isFile()) {
            continue;
        }
        fs.mkdirSync(dest, { recursive: true });
        fs.copyFileSync(source, path.join(dest, path.basename(entry)));
    }
}

/** Warn about anything in a source skill folder we deliberately do not import (e.g. bundled scripts). */
function warnSkipped(srcSkillDir: string, slug: string): void {
    for (const entry of fs.readdirSync(srcSkillDir)) {
        if (entry === "SKILL.md" || entry === "screenshots") {
            continue;
        }
        logger.warn(`  ${slug}: not importing "${entry}" (only SKILL.md + screenshots are imported)`);
    }
}

function bodyOf(md: string): string {
    return md.replace(/^---\n[\s\S]*?\n---\n?/, "").trimEnd();
}

function isGeneral(slug: string, area: string | null, routes: string[]): boolean {
    return /(^|-)navigation$/.test(slug) || (area === null && routes.length === 0);
}

function loadIndex(file: string): ImportedIndex {
    if (!fs.existsSync(file)) {
        return { skills: [] };
    }
    try {
        const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as ImportedIndex;
        return Array.isArray(parsed.skills) ? parsed : { skills: [] };
    } catch {
        return { skills: [] };
    }
}

/**
 * Install a shared navigation skill pack into the project's skills directory so the
 * Phase 3 loader picks it up. SECURITY: imports are descriptive only — frontmatter is
 * re-serialized from scratch (dropping any `allowed-tools` or other capability grants)
 * and only SKILL.md + image assets are copied (never bundled scripts). The import
 * index is kept separate from the generated pack so it survives regeneration.
 */
export function importSkillPack(args: ImportSkillPackArgs): ImportResult {
    const { outputDir, adapterId, sourceDir, overwrite } = args;
    if (!fs.existsSync(sourceDir)) {
        throw new Error(`Source not found: ${sourceDir}`);
    }
    const skillDirs = findSkillDirs(sourceDir);
    if (skillDirs.length === 0) {
        throw new Error(`No SKILL.md found under ${sourceDir}.`);
    }

    const destRoot = path.join(outputDir, adapterId, "skills");
    fs.mkdirSync(destRoot, { recursive: true });

    const installed: string[] = [];
    const skipped: string[] = [];
    const entries: ImportedSkillEntry[] = [];

    for (const skillDir of skillDirs) {
        const raw = fs.readFileSync(path.join(skillDir, "SKILL.md"), "utf8");
        const parsed = parseFrontmatter(raw);
        const slug = slugify(parsed.name || path.basename(skillDir));
        if (!slug) {
            continue;
        }

        const destDir = path.join(destRoot, slug);
        if (fs.existsSync(destDir) && !overwrite) {
            skipped.push(slug);
            continue;
        }

        const area = parsed.area ?? null;
        const routes = parsed.routes ?? [];
        // Re-serialize the frontmatter ourselves so no capability fields survive the import.
        const frontmatter: SkillFrontmatter = {
            name: slug,
            description: parsed.description || `Imported navigation skill ${slug}.`,
            metadata: {
                source: parsed.source || "imported",
                baseUrl: parsed.baseUrl || "",
                gitSha: parsed.gitSha ?? null,
                area,
                routes,
                createdAt: parsed.createdAt || new Date().toISOString(),
            },
        };

        fs.mkdirSync(destDir, { recursive: true });
        const content = `${serializeFrontmatter(frontmatter)}\n\n${bodyOf(raw)}\n`;
        fs.writeFileSync(path.join(destDir, "SKILL.md"), redactSecret(content));
        copyImages(skillDir, destDir);
        warnSkipped(skillDir, slug);

        installed.push(slug);
        entries.push({
            slug,
            area,
            routes,
            source: frontmatter.metadata.source,
            general: isGeneral(slug, area, routes),
        });
    }

    // Merge into the import index: drop prior entries for the slugs we just (re)installed.
    const indexFile = path.join(destRoot, "imported.json");
    const index = loadIndex(indexFile);
    const installedSet = new Set(installed);
    const merged = index.skills.filter((entry) => !installedSet.has(entry.slug)).concat(entries);
    fs.writeFileSync(indexFile, redactSecret(JSON.stringify({ skills: merged }, null, 2)));

    return { installed, skipped, total: skillDirs.length };
}
