import { z } from "zod";
import { applyEnvVar, EnvFileWriteError, isReservedSecretEnvName } from "../index";
import { HttpError } from "./errors";
import { listProjects } from "./store";

/**
 * The app-layer env settings surface. The KEY allowlist + secret classification
 * live HERE (never in core). Secrets are reported as presence booleans only; values
 * are echoed back only for non-secret config keys (so the form can prefill).
 * SENTINEL_ALLOW_PROD_WRITES / SENTINEL_READ_ONLY are deliberately NOT allowlisted,
 * so the UI can never weaken the read-only safety boundary.
 */
const STATIC_ALLOWLIST = [
    "SENTINEL_EMAIL",
    "SENTINEL_PASSWORD",
    "SENTINEL_BASE_URL",
    "SENTINEL_HEADLESS",
    "SENTINEL_LLM_PROVIDER",
    "SENTINEL_LLM_MODEL",
    "GH_TOKEN",
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_REGION",
] as const;

// Default-deny: ONLY these explicitly non-secret config keys have their VALUE echoed
// by GET /api/env. Every other allowlisted key — including per-project credential
// env-var names, which are added to the allowlist dynamically — is reported
// presence-only, so a secret value can never leave the process.
const NON_SECRET_KEYS = new Set<string>([
    "SENTINEL_BASE_URL",
    "SENTINEL_HEADLESS",
    "SENTINEL_LLM_PROVIDER",
    "SENTINEL_LLM_MODEL",
    "AWS_REGION",
]);

const KEY_RE = /^[A-Z][A-Z0-9_]*$/;

/**
 * Static keys ∪ each registered project's declared credential env-var names ∪ its
 * run-recipe secret names — the registration form promises recipe secret VALUES are
 * set in Settings, so every declared name must be manageable here. Reserved names
 * (Sentinel's own credentials) are excluded even if persisted by an older record.
 */
async function resolveAllowlist(): Promise<Set<string>> {
    const allow = new Set<string>(STATIC_ALLOWLIST);
    for (const project of await listProjects()) {
        for (const key of [project.adapter?.emailEnv, project.adapter?.passwordEnv]) {
            if (key && KEY_RE.test(key)) {
                allow.add(key);
            }
        }
        // Recipe secrets must never name Sentinel's own credentials (the launcher refuses
        // them anyway) — don't let an older persisted record open them up for writing.
        // Per-project login creds are exempt: their convention IS the SENTINEL_ prefix.
        for (const key of project.runRecipe?.secretEnv ?? []) {
            if (KEY_RE.test(key) && !isReservedSecretEnvName(key)) {
                allow.add(key);
            }
        }
    }
    return allow;
}

function isSet(key: string): boolean {
    const value = process.env[key];
    return Boolean(value && value !== "");
}

export interface EnvPresence {
    keys: Record<string, { set: boolean }>;
    values: Record<string, string>;
}

export async function getEnvPresence(): Promise<EnvPresence> {
    const allow = await resolveAllowlist();
    const keys: Record<string, { set: boolean }> = {};
    const values: Record<string, string> = {};
    for (const key of allow) {
        keys[key] = { set: isSet(key) };
        if (NON_SECRET_KEYS.has(key)) {
            const value = process.env[key];
            if (value !== undefined && value !== "") {
                values[key] = value;
            }
        }
    }
    return { keys, values };
}

const updateSchema = z.object({ updates: z.record(z.string(), z.string()) });

function validateValue(key: string, value: string): void {
    if (value === "") {
        return; // clearing a key is always allowed
    }
    if (key === "SENTINEL_LLM_PROVIDER" && !["anthropic", "openai", "bedrock"].includes(value)) {
        throw new HttpError(400, "SENTINEL_LLM_PROVIDER must be anthropic | openai | bedrock");
    }
    if (key === "SENTINEL_HEADLESS" && !["true", "false"].includes(value.toLowerCase())) {
        throw new HttpError(400, "SENTINEL_HEADLESS must be true or false");
    }
    if (key === "SENTINEL_BASE_URL") {
        try {
            const url = new URL(value);
            if (url.protocol !== "http:" && url.protocol !== "https:") {
                throw new Error("not http(s)");
            }
        } catch {
            throw new HttpError(400, "SENTINEL_BASE_URL must be an http(s) URL");
        }
    }
}

export async function updateEnv(body: unknown): Promise<{ ok: true; applied: string[] }> {
    const parsed = updateSchema.safeParse(body);
    if (!parsed.success) {
        throw new HttpError(400, "body must be { updates: { KEY: value } }");
    }
    const allow = await resolveAllowlist();
    const applied: string[] = [];
    for (const [key, value] of Object.entries(parsed.data.updates)) {
        if (!allow.has(key)) {
            throw new HttpError(400, `key not allowed: ${key}`);
        }
        validateValue(key, value);
        try {
            applyEnvVar(key, value);
        } catch (error) {
            // EnvFileWriteError carries a key name only, never a value.
            if (error instanceof EnvFileWriteError) {
                throw new HttpError(400, error.message);
            }
            throw error;
        }
        applied.push(key);
    }
    return { ok: true, applied };
}
