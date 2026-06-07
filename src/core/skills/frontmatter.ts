import type { SkillFrontmatter } from "./types";

/**
 * Quote a scalar as a double-quoted string. JSON strings are valid YAML 1.2 scalars,
 * so this safely escapes colons, quotes, and newlines that would otherwise break the
 * frontmatter block.
 */
function scalar(value: string): string {
    return JSON.stringify(value);
}

/** Serialize skill frontmatter into a YAML block delimited by `---` lines. */
export function serializeFrontmatter(fm: SkillFrontmatter): string {
    const m = fm.metadata;
    const routes = m.routes.map(scalar).join(", ");
    const lines = [
        "---",
        `name: ${scalar(fm.name)}`,
        `description: ${scalar(fm.description)}`,
        "metadata:",
        `  source: ${scalar(m.source)}`,
        `  baseUrl: ${scalar(m.baseUrl)}`,
        `  gitSha: ${m.gitSha === null ? "null" : scalar(m.gitSha)}`,
        `  area: ${m.area === null ? "null" : scalar(m.area)}`,
        `  routes: [${routes}]`,
        `  createdAt: ${scalar(m.createdAt)}`,
        "---",
    ];
    return lines.join("\n");
}
