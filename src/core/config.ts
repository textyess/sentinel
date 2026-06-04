import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as dotenv from "dotenv";

const here = path.dirname(fileURLToPath(import.meta.url));
/** The Sentinel package root — two levels up from src/core. */
export const PACKAGE_ROOT = path.resolve(here, "..", "..");
/**
 * The repo whose local files (e.g. .env) an adapter may inspect. Standalone, that
 * is this package; set SENTINEL_REPO_ROOT to point at a target repo/monorepo.
 */
export const REPO_ROOT = process.env.SENTINEL_REPO_ROOT
    ? path.resolve(process.env.SENTINEL_REPO_ROOT)
    : PACKAGE_ROOT;

dotenv.config({ path: path.join(PACKAGE_ROOT, ".env") });

export interface EnvConfig {
    email: string | null;
    password: string | null;
    baseUrl: string | null;
    headless: boolean;
    readOnly: boolean;
    allowProdWrites: boolean;
    outputDir: string;
    /** Per-step login timeout. Generous by default to tolerate Next.js dev cold-compile. */
    loginTimeoutMs: number;
    /** LLM provider for the reasoning layer (site map, later interaction/verdict). */
    llmProvider: "anthropic" | "openai" | "bedrock";
    /** Model id passed to the provider. */
    llmModel: string;
    /** Human-like pacing: think-pauses + adaptive per-page dwell. */
    humanPacing: boolean;
    /** Base think-time between actions (ms). */
    paceMs: number;
    /** Cap on per-page dwell (ms). */
    maxDwellMs: number;
}

function boolEnv(value: string | undefined, fallback: boolean): boolean {
    if (value === undefined || value === "") {
        return fallback;
    }
    return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function numEnv(value: string | undefined, fallback: number): number {
    if (value === undefined || value === "") {
        return fallback;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function loadEnvConfig(): EnvConfig {
    const rawProvider = (process.env.SENTINEL_LLM_PROVIDER || "anthropic").toLowerCase();
    const llmProvider: EnvConfig["llmProvider"] =
        rawProvider === "openai" ? "openai" : rawProvider === "bedrock" ? "bedrock" : "anthropic";
    const defaultModel =
        llmProvider === "openai"
            ? "gpt-4o"
            : llmProvider === "bedrock"
              ? "eu.anthropic.claude-sonnet-4-6"
              : "claude-3-5-sonnet-latest";
    return {
        email: process.env.SENTINEL_EMAIL || null,
        password: process.env.SENTINEL_PASSWORD || null,
        baseUrl: process.env.SENTINEL_BASE_URL || null,
        headless: boolEnv(process.env.SENTINEL_HEADLESS, true),
        readOnly: boolEnv(process.env.SENTINEL_READ_ONLY, true),
        allowProdWrites: boolEnv(process.env.SENTINEL_ALLOW_PROD_WRITES, false),
        outputDir: process.env.SENTINEL_OUTPUT_DIR || path.join(PACKAGE_ROOT, ".sentinel"),
        loginTimeoutMs: numEnv(process.env.SENTINEL_LOGIN_TIMEOUT, 45000),
        llmProvider,
        llmModel: process.env.SENTINEL_LLM_MODEL || defaultModel,
        humanPacing: boolEnv(process.env.SENTINEL_HUMAN_PACING, true),
        paceMs: numEnv(process.env.SENTINEL_PACE_MS, 700),
        maxDwellMs: numEnv(process.env.SENTINEL_MAX_DWELL_MS, 6000),
    };
}
