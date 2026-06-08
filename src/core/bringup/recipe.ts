/**
 * A declarative recipe for starting a target app locally from a checked-out branch,
 * for repos that have no PR preview deployment. It is the no-preview counterpart to
 * `resolveWebPreviewUrl`: instead of reading a URL off the GitHub Deployments API,
 * Sentinel runs the app itself and points the browser at the local port.
 *
 * Repo-agnostic by construction — every field is supplied at registration time, never
 * hard-coded per repo. Secrets are NEVER stored here: the runtime env is resolved from
 * Sentinel-managed env-var names just before launch (see {@link RunRecipe.env}).
 */
export interface RunRecipe {
    /** Optional dependency-install command, e.g. "npm ci". Skipped when omitted. */
    installCmd?: string;
    /** Command that starts the app's web server, e.g. "npm run dev". */
    runCmd: string;
    /** Port the app listens on once started — the contract handed to the app via PORT. */
    port: number;
    /** Path probed for readiness (default "/"). Any HTTP response counts as up. */
    readyPath?: string;
    /**
     * Fully-resolved environment to inject into the spawned app (non-secret config plus
     * any secrets already looked up by name). This is the ONLY app-provided env the child
     * sees — Sentinel's own secrets are never forwarded. See the launch env allowlist.
     */
    env?: Record<string, string>;
    /** Max time to wait for {@link installCmd} to finish (ms). */
    installTimeoutMs?: number;
    /** Max time to wait for the app to answer HTTP after {@link runCmd} starts (ms). */
    readyTimeoutMs?: number;
}

export const DEFAULT_READY_PATH = "/";
/** Installs (npm/pnpm/yarn) routinely take minutes on a cold cache. */
export const DEFAULT_INSTALL_TIMEOUT_MS = 5 * 60_000;
/** Generous, to tolerate a dev server's first-request cold compile (Next.js et al.). */
export const DEFAULT_READY_TIMEOUT_MS = 90_000;

/**
 * The persisted form of a {@link RunRecipe} stored on a project. Secrets are referenced
 * by env-var NAME (looked up from Sentinel's managed env at launch), never stored raw —
 * mirroring the emailEnv/passwordEnv convention. Non-secret config lives inline in
 * {@link PersistedRunRecipe.env}.
 */
export interface PersistedRunRecipe {
    installCmd?: string;
    runCmd: string;
    port: number;
    readyPath?: string;
    /** Non-secret env literals safe to persist (e.g. NEXT_PUBLIC_API_URL). */
    env?: Record<string, string>;
    /** Names of Sentinel-managed env vars whose values are injected at launch (secrets). */
    secretEnv?: string[];
    installTimeoutMs?: number;
    readyTimeoutMs?: number;
}

export interface ResolvedRecipe {
    recipe: RunRecipe;
    /** Declared secret env names that were missing/empty in the environment. */
    missingSecrets: string[];
    /** Declared secret env names refused because they name Sentinel's OWN credentials. */
    rejectedSecrets: string[];
}

/**
 * Env-var names a recipe may NEVER reference in {@link PersistedRunRecipe.secretEnv}:
 * Sentinel's OWN credentials. A PR's install/run scripts are attacker-influenced code, so
 * resolving these out of Sentinel's process.env and handing them to the child would leak
 * the GitHub token / LLM / cloud keys and defeat the launch env allowlist. Matched
 * structurally (the agent's own infra prefixes/names, never a target-repo string), so core
 * stays repo-agnostic.
 */
export function isReservedSecretEnvName(name: string): boolean {
    const upper = name.toUpperCase();
    return (
        upper.startsWith("SENTINEL_") ||
        upper.startsWith("AWS_") ||
        upper === "GH_TOKEN" ||
        upper === "GITHUB_TOKEN" ||
        upper === "ANTHROPIC_API_KEY" ||
        upper === "OPENAI_API_KEY"
    );
}

/**
 * Resolve a persisted recipe into a launch-ready {@link RunRecipe}: merge the non-secret
 * literals with the looked-up value of each declared secret env var. A name that collides
 * with one of Sentinel's own credentials is REFUSED (never resolved) — a defense-in-depth
 * backstop for a recipe persisted before validation or via a non-API path. Missing secrets
 * are REPORTED, not thrown; the caller decides whether a missing/rejected var is fatal.
 */
export function resolvePersistedRecipe(persisted: PersistedRunRecipe): ResolvedRecipe {
    const env: Record<string, string> = { ...(persisted.env ?? {}) };
    const missingSecrets: string[] = [];
    const rejectedSecrets: string[] = [];
    for (const name of persisted.secretEnv ?? []) {
        if (isReservedSecretEnvName(name)) {
            rejectedSecrets.push(name);
            continue;
        }
        const value = process.env[name];
        if (value === undefined || value === "") {
            missingSecrets.push(name);
            continue;
        }
        env[name] = value;
    }
    return {
        recipe: {
            installCmd: persisted.installCmd,
            runCmd: persisted.runCmd,
            port: persisted.port,
            readyPath: persisted.readyPath,
            env,
            installTimeoutMs: persisted.installTimeoutMs,
            readyTimeoutMs: persisted.readyTimeoutMs,
        },
        missingSecrets,
        rejectedSecrets,
    };
}
