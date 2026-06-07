/**
 * A navigation skill pack: Sentinel's interaction graph, projected into loadable
 * Agent Skills. One general "how this app works" skill plus one skill per route
 * area, each a folder with a SKILL.md (frontmatter + Markdown body). The pack is a
 * portable, shareable artifact — the structure mirrors a `.claude/skills/` layout so
 * a generated skill can be dropped straight into another agent's skill directory.
 */

/** YAML frontmatter at the top of every SKILL.md. `description` is the always-in-context hook progressive disclosure matches on. */
export interface SkillFrontmatter {
    /** Globally-unique skill name, also the folder name, e.g. "acme-campaigns". */
    name: string;
    /** One line stating what the skill covers and when to load it; includes the routes for matchability. */
    description: string;
    metadata: {
        /** The app the skill was mapped from (the adapter / repo id). */
        source: string;
        baseUrl: string;
        /** Repo HEAD sha when the underlying graph was crawled — lets an importer detect drift. */
        gitSha: string | null;
        /** Route area this skill covers, or null for the general navigation skill. */
        area: string | null;
        /** Templated routes the skill covers, e.g. ["/campaigns", "/campaigns/:id"]. */
        routes: string[];
        createdAt: string;
    };
}

export interface SkillDoc {
    /** Folder name under skills/ — equals frontmatter.name. */
    slug: string;
    frontmatter: SkillFrontmatter;
    /** Markdown body below the frontmatter (no `---` fences). */
    body: string;
    /** Graph-relative screenshot paths to bundle into the skill folder. */
    screenshots: string[];
}

export interface SkillPackManifest {
    source: string;
    baseUrl: string;
    gitSha: string | null;
    createdAt: string;
    /** Slug of the general navigation skill. */
    general: string;
    areas: { area: string | null; slug: string; routes: string[] }[];
    /** Templated route -> owning area slug, so a consumer can map affected routes to skills. */
    routeIndex: Record<string, string>;
}

export interface SkillPack {
    dir: string;
    manifest: SkillPackManifest;
    skillCount: number;
}

/**
 * One imported skill's index entry. Imports are tracked in skills/imported.json
 * (separate from the generated pack.json) so they survive a `sentinel skills`
 * regeneration, which rewrites pack.json from a fresh crawl.
 */
export interface ImportedSkillEntry {
    slug: string;
    area: string | null;
    routes: string[];
    /** The app the skill was authored/exported from (frontmatter metadata.source). */
    source: string;
    /** True for a general "how the app works" skill — loaded regardless of route. */
    general: boolean;
}

export interface ImportedIndex {
    skills: ImportedSkillEntry[];
}

/**
 * An LLM-authored skill: the free-prose Markdown body plus a declaration of the
 * concrete routes/controls/selectors/destructive-controls it referenced. The
 * references make verification exact set-membership against the graph rather than
 * brittle parsing of the prose.
 */
export interface AuthoredSkill {
    body: string;
    references: {
        routes: string[];
        controls: string[];
        selectors: string[];
        destructive: string[];
    };
}
