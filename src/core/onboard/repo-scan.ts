import { isReservedSecretEnvName } from "../bringup/recipe";
import { listRepoDir, readRepoFile } from "../pr/github";

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

/**
 * A best-effort proposal for the no-preview run recipe, inferred clone-free from a repo's
 * lockfile, package.json scripts, docker-compose, and .env.example. Every field is a
 * starting point the operator reviews — the live "Test bring-up" is what actually proves it.
 */
export interface RunRecipeProposal {
    installCmd: string;
    runCmd: string;
    port: number;
    readyPath: string;
    /** Candidate secret env-var NAMES read from .env.example (Sentinel-reserved names excluded). */
    secretEnv: string[];
    notes: string[];
}

const LOCKFILE_PM: Array<{ file: string; pm: "pnpm" | "yarn" | "bun" | "npm" }> = [
    { file: "pnpm-lock.yaml", pm: "pnpm" },
    { file: "yarn.lock", pm: "yarn" },
    { file: "bun.lockb", pm: "bun" },
    { file: "package-lock.json", pm: "npm" },
];

function installCommand(pm: "pnpm" | "yarn" | "bun" | "npm"): string {
    return pm === "yarn" ? "yarn" : `${pm} install`;
}

function runCommand(pm: "pnpm" | "yarn" | "bun" | "npm", script: string): string {
    // npm and bun need `run`; pnpm and yarn take the script name directly.
    return pm === "npm" || pm === "bun" ? `${pm} run ${script}` : `${pm} ${script}`;
}

/** Pull an explicit port out of a dev/start script's flags (e.g. `next dev -p 4000`). */
function portFromScript(script: string): number | null {
    const match = script.match(/(?:-p|--port)[ =]+(\d{2,5})/);
    if (!match?.[1]) {
        return null;
    }
    const port = Number.parseInt(match[1], 10);
    return port > 0 && port <= 65535 ? port : null;
}

function frameworkDefaultPort(names: Set<string>): number {
    const has = (re: RegExp): boolean => [...names].some((n) => re.test(n));
    if (has(/^vite\.config\./)) {
        return 5173;
    }
    if (has(/^astro\.config\./)) {
        return 4321;
    }
    // Next, Remix, Nuxt, CRA all default to 3000.
    return 3000;
}

/**
 * Inspect a repo (no clone) and propose how to start it for the no-preview path. Reads the
 * lockfile (package manager), package.json (dev/start script + any explicit port),
 * docker-compose (full-stack start), and .env.example (secret names). Returns null when the
 * repo can't be read (e.g. gh not authenticated).
 */
export async function detectRunRecipe(repo: string): Promise<RunRecipeProposal | null> {
    const root = await listRepoDir(repo, "");
    if (!root) {
        return null;
    }
    const names = new Set(root.map((e) => e.name));
    const notes: string[] = [];

    const pm = LOCKFILE_PM.find((l) => names.has(l.file))?.pm ?? "npm";
    if (!LOCKFILE_PM.some((l) => names.has(l.file))) {
        notes.push("No lockfile found — assuming npm; change the install command if the repo uses pnpm/yarn/bun.");
    }

    const hasCompose = ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"].some((f) =>
        names.has(f),
    );

    let scripts: Record<string, string> = {};
    if (names.has("package.json")) {
        const raw = await readRepoFile(repo, "package.json");
        if (raw) {
            try {
                scripts = ((JSON.parse(raw) as { scripts?: Record<string, string> }).scripts ?? {}) as Record<
                    string,
                    string
                >;
            } catch {
                notes.push("Could not parse package.json — set the start command manually.");
            }
        }
    }

    const scriptName = scripts.dev ? "dev" : scripts.start ? "start" : scripts.serve ? "serve" : null;
    let runCmd: string;
    if (!scriptName && hasCompose) {
        runCmd = "docker compose up";
        notes.push(
            "Found docker-compose — proposing `docker compose up` to start the full stack (needs Docker on the Sentinel host; not available in the standard container deployment).",
        );
    } else {
        const script = scriptName ?? "dev";
        runCmd = runCommand(pm, script);
        if (!scriptName) {
            notes.push("No dev/start/serve script in package.json — defaulting to `dev`; adjust if needed.");
        }
    }

    const port = (scriptName ? portFromScript(scripts[scriptName] ?? "") : null) ?? frameworkDefaultPort(names);

    const secretEnv: string[] = [];
    const envExample = [".env.example", ".env.sample", ".env.template"].find((f) => names.has(f));
    if (envExample) {
        const raw = await readRepoFile(repo, envExample);
        for (const line of (raw ?? "").split("\n")) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith("#")) {
                continue;
            }
            const eq = trimmed.indexOf("=");
            if (eq <= 0) {
                continue;
            }
            const key = trimmed.slice(0, eq).trim();
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
                continue;
            }
            // Public client config isn't a secret; Sentinel's own names are reserved.
            if (/^(NEXT_PUBLIC_|PUBLIC_|VITE_)/.test(key) || isReservedSecretEnvName(key)) {
                continue;
            }
            if (!secretEnv.includes(key)) {
                secretEnv.push(key);
            }
        }
        if (secretEnv.length > 0) {
            notes.push(`Found ${secretEnv.length} env var(s) in ${envExample} — set their values in Settings.`);
        }
    }

    return { installCmd: installCommand(pm), runCmd, port, readyPath: "/", secretEnv, notes };
}
