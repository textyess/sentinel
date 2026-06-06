/**
 * Project-id slug: lowercased "owner/name" with non-alphanumerics collapsed to
 * hyphens. Used as the adapter id and output subdir (never contains "__").
 */
export function slug(repo: string): string {
    return repo
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
}

/**
 * Derive the Sentinel-side env-var NAMES that hold a project's test credentials.
 * These are names only — never the secrets. They must satisfy env-api's KEY_RE
 * (/^[A-Z][A-Z0-9_]*$/), which the "SENTINEL_" prefix + uppercased slug guarantees.
 */
export function credEnvNames(repo: string): { emailEnv: string; passwordEnv: string } {
    const base = slug(repo).replace(/-/g, "_").toUpperCase() || "PROJECT";
    return { emailEnv: `SENTINEL_${base}_EMAIL`, passwordEnv: `SENTINEL_${base}_PASSWORD` };
}
