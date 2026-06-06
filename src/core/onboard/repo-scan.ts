import { listRepoDir } from "../pr/github";

/**
 * A light, clone-free scan of a repo's structure to infer the route-file convention
 * (`pagesPrefix`) used to map a PR's changed files to routes. This is a source-only
 * fact the live app cannot reveal, so it is the one signal worth reading from the repo.
 * Best-effort: any uncertainty returns a null prefix with a note rather than a guess.
 */
export interface RepoScanResult {
    pagesPrefix: string | null;
    framework: string | null;
    notes: string[];
}

const NEXT_CONFIGS = ["next.config.js", "next.config.ts", "next.config.mjs", "next.config.cjs"];
const REMIX_CONFIGS = ["remix.config.js", "remix.config.ts", "remix.config.mjs"];
const ASTRO_CONFIGS = ["astro.config.mjs", "astro.config.ts", "astro.config.js"];
const NUXT_CONFIGS = ["nuxt.config.ts", "nuxt.config.js"];

export async function scanRepo(repo: string): Promise<RepoScanResult> {
    const notes: string[] = [];
    const root = await listRepoDir(repo, "");
    if (!root) {
        return {
            pagesPrefix: null,
            framework: null,
            notes: ["Could not read the repository contents (check `gh auth`) — set the pages prefix manually."],
        };
    }

    const names = new Set(root.map((e) => e.name));
    const dirs = new Set(root.filter((e) => e.type === "dir").map((e) => e.name));
    const hasAny = (list: string[]): boolean => list.some((n) => names.has(n));
    const done = (pagesPrefix: string, framework: string): RepoScanResult => ({ pagesPrefix, framework, notes });
    const dirNames = async (dir: string): Promise<Set<string>> =>
        new Set(((await listRepoDir(repo, dir)) ?? []).map((e) => e.name));

    // Route files in a monorepo live under apps/<app>/… — too ambiguous to pick one.
    if (dirs.has("apps") || dirs.has("packages")) {
        notes.push(
            "Looks like a monorepo — set the pages prefix to the web app's route dir (e.g. apps/web/src/pages/ or apps/web/app/).",
        );
        return { pagesPrefix: null, framework: "monorepo", notes };
    }

    if (hasAny(NEXT_CONFIGS)) {
        if (dirs.has("app")) {
            return done("app/", "Next.js (App Router)");
        }
        if (dirs.has("pages")) {
            return done("pages/", "Next.js (Pages Router)");
        }
        if (dirs.has("src")) {
            const src = await dirNames("src");
            if (src.has("app")) {
                return done("src/app/", "Next.js (App Router)");
            }
            if (src.has("pages")) {
                return done("src/pages/", "Next.js (Pages Router)");
            }
        }
        notes.push("Next.js detected but no app/ or pages/ dir was found — set the pages prefix manually.");
        return { pagesPrefix: null, framework: "Next.js", notes };
    }

    if (hasAny(REMIX_CONFIGS)) {
        const app = dirs.has("app") ? await dirNames("app") : new Set<string>();
        return done(app.has("routes") ? "app/routes/" : "app/", "Remix");
    }

    if (hasAny(ASTRO_CONFIGS)) {
        return done("src/pages/", "Astro");
    }

    if (hasAny(NUXT_CONFIGS)) {
        return done("pages/", "Nuxt");
    }

    // Generic Vite / CRA SPA — look for a conventional routes/pages dir.
    if (dirs.has("src")) {
        const src = await dirNames("src");
        if (src.has("pages")) {
            return done("src/pages/", "src/pages");
        }
        if (src.has("app")) {
            return done("src/app/", "src/app");
        }
        if (src.has("routes")) {
            return done("src/routes/", "src/routes");
        }
    }
    if (dirs.has("pages")) {
        return done("pages/", "pages");
    }

    notes.push(
        "Could not infer a route-file convention — set the pages prefix manually (it only maps PR diffs to routes).",
    );
    return { pagesPrefix: null, framework: null, notes };
}
