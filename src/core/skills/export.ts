import * as fs from "node:fs";
import * as path from "node:path";
import { redactSecret } from "../safety/redact";
import type { SkillPackManifest } from "./types";
import { SAFETY_HEADING, SELECTORS_HEADING } from "./verify";

export interface ExportSkillPackArgs {
    outputDir: string;
    adapterId: string;
    /** Destination directory for the portable copy. */
    outDir: string;
}

export interface ExportResult {
    dir: string;
    skillCount: number;
}

/** An external agent has no Sentinel harness, so the read-only guarantee doesn't hold for it. */
const PORTABLE_SAFETY =
    "This skill describes navigation only. Your runtime — not Sentinel — governs safety here; the read-only guard " +
    "does NOT apply. Treat every control listed as destructive as live: do not click create/save/send/delete/pay/" +
    "publish controls unless your task explicitly requires it.";

function splitFrontmatter(md: string): { frontmatter: string; body: string } {
    const match = md.match(/^---\n[\s\S]*?\n---\n?/);
    if (!match) {
        return { frontmatter: "", body: md };
    }
    const frontmatter = match[0];
    return { frontmatter, body: md.slice(frontmatter.length) };
}

/** Remove a whole `## <heading>` section (heading line through the line before the next `##`). */
function dropSection(body: string, headingPrefix: string): string {
    const out: string[] = [];
    let skipping = false;
    for (const line of body.split("\n")) {
        // Detect headings on the trimmed line so the verifier (which trims) and this exporter
        // agree — an indented heading must not slip an internal section into the portable pack.
        const trimmed = line.trim();
        if (trimmed.startsWith("## ")) {
            skipping = trimmed.startsWith(headingPrefix);
        }
        if (!skipping) {
            out.push(line);
        }
    }
    return out.join("\n");
}

/** Replace the internal Safety section body with a portable warning, or append one if absent. */
function rewriteSafety(body: string): string {
    const out: string[] = [];
    let inSafety = false;
    for (const line of body.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.startsWith("## ")) {
            if (trimmed === SAFETY_HEADING) {
                out.push(line, PORTABLE_SAFETY);
                inSafety = true;
                continue;
            }
            inSafety = false;
        }
        if (!inSafety) {
            out.push(line);
        }
    }
    let result = out.join("\n").trimEnd();
    if (!result.includes(SAFETY_HEADING)) {
        result += `\n\n${SAFETY_HEADING}\n${PORTABLE_SAFETY}`;
    }
    return result;
}

/**
 * Internal → portable SKILL.md: strip the brittle selectors, rewrite the safety note, keep the rest.
 * Depends on the exact section headings the authoring prompt + verifier enforce (SELECTORS_HEADING,
 * SAFETY_HEADING) — those constants are the single source of truth, imported from verify.ts.
 */
function toPortable(md: string): string {
    const { frontmatter, body } = splitFrontmatter(md);
    const transformed = rewriteSafety(dropSection(body, SELECTORS_HEADING));
    return `${frontmatter.trimEnd()}\n\n${transformed.trim()}\n`;
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg)$/i;

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

/**
 * Produce a portable copy of the generated skill pack that another agent can use:
 * each SKILL.md has its internal selector appendix removed and its safety note
 * rewritten for a runtime without Sentinel's guards. The flat per-skill folders drop
 * straight into a `.claude/skills/` directory. Files are re-redacted on the way out.
 */
export function exportSkillPack(args: ExportSkillPackArgs): ExportResult {
    const source = path.join(args.outputDir, args.adapterId, "skills");
    if (!fs.existsSync(path.join(source, "pack.json"))) {
        throw new Error(`No skill pack at ${source}. Run \`sentinel skills\` first.`);
    }

    fs.mkdirSync(args.outDir, { recursive: true });
    let skillCount = 0;
    for (const entry of fs.readdirSync(source)) {
        const skillDir = path.join(source, entry);
        const skillFile = path.join(skillDir, "SKILL.md");
        if (!fs.statSync(skillDir).isDirectory() || !fs.existsSync(skillFile)) {
            continue;
        }
        const destDir = path.join(args.outDir, entry);
        fs.mkdirSync(destDir, { recursive: true });
        const portable = toPortable(fs.readFileSync(skillFile, "utf8"));
        fs.writeFileSync(path.join(destDir, "SKILL.md"), redactSecret(portable));
        copyImages(skillDir, destDir);
        skillCount += 1;
    }

    // Carry the manifest so the pack round-trips on import; mark it portable.
    const manifest = JSON.parse(fs.readFileSync(path.join(source, "pack.json"), "utf8")) as SkillPackManifest;
    const exported = { ...manifest, portable: true, exportedAt: new Date().toISOString() };
    fs.writeFileSync(path.join(args.outDir, "pack.json"), redactSecret(JSON.stringify(exported, null, 2)));

    return { dir: args.outDir, skillCount };
}
