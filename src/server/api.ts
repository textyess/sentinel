import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import type { GenericProjectConfig } from "../adapters/generic";
import { adapterKinds, isAdapterKind, isGhAuthenticated, llmCredentialIssue, loadEnvConfig } from "../index";
import { HttpError } from "./errors";
import { indexRuns, resolveRunArtifacts } from "./indexer";
import { credEnvNames, slug } from "./naming";
import { isPollerRunning } from "./poller";
import {
    isAutodetectRunning,
    isCrawlRunning,
    isPrRunning,
    triggerAutodetectInBackground,
    triggerCrawlInBackground,
    triggerRunInBackground,
} from "./runner";
import { getProject, listProjects, listRunRecords, removeProject, removeRunRecord, upsertProject } from "./store";
import type { ProjectRecord, RunRecord, RunSummary } from "./types";

/** A RegExpSource that the core will compile with `new RegExp(...)` — reject one that can't. */
function isCompilableRegex(source: string): boolean {
    try {
        new RegExp(source);
        return true;
    } catch {
        return false;
    }
}

const authSchema = z.object({
    loginPath: z.string().min(1),
    emailLabel: z.string().min(1),
    passwordLabel: z.string().min(1),
    // Compiled via new RegExp by the core — reject a value that won't compile so a bad
    // (e.g. auto-detected) pattern can never be persisted and later throw in performLogin.
    submitNamePattern: z.string().min(1).refine(isCompilableRegex, "submitNamePattern must be a valid regex"),
    authenticatedUrlPattern: z
        .string()
        .min(1)
        .refine(isCompilableRegex, "authenticatedUrlPattern must be a valid regex"),
    emailFallbackSelector: z.string().optional(),
    passwordFallbackSelector: z.string().optional(),
    publicRoutes: z.array(z.string()).default([]),
});

const genericAdapterSchema = z.object({
    auth: authSchema,
    // When false, the app is public: Sentinel crawls/verifies without signing in and
    // needs no credentials. Defaults to true so existing/omitted configs require login.
    authRequired: z.boolean().optional().default(true),
    // Credential env-var NAMES. Optional — when omitted they are derived from the repo
    // slug (SENTINEL_<SLUG>_EMAIL/_PASSWORD) so the registration form need not ask.
    emailEnv: z.string().min(1).optional(),
    passwordEnv: z.string().min(1).optional(),
    previewEnvIncludes: z.string().default("web"),
    pagesPrefix: z.string().optional(),
    knownRoutes: z.array(z.string()).optional(),
    // Must be anchored (auth paths only) so a broad operator-supplied pattern can't
    // punch a wide write hole through the read-only guard — and must compile cleanly.
    allowedMutationPatterns: z
        .array(
            z
                .string()
                .regex(/^\^/, "each pattern must be anchored with ^ (auth paths only)")
                .refine(isCompilableRegex, "each pattern must be a valid regex"),
        )
        .default([]),
    productionMarkers: z.array(z.string()).optional(),
    destructiveControlPatterns: z.array(z.string()).optional(),
});

const projectSchema = z
    .object({
        repo: z.string().regex(/^[^/\s]+\/[^/\s]+$/, "repo must be owner/name"),
        adapterKind: z.string().refine(isAdapterKind, "unknown adapter kind"),
        previewEnvIncludes: z.string().default("web"),
        mentionHandle: z.string().default("@sentinel"),
        baselineUrl: z.string().url().nullable().optional(),
        adapter: genericAdapterSchema.nullable().optional(),
    })
    .refine((d) => d.adapterKind !== "generic" || Boolean(d.adapter), {
        message: "generic projects require an adapter config",
        path: ["adapter"],
    });

export interface ProjectView extends ProjectRecord {
    graphPresent: boolean;
    credsConfigured: boolean;
    /** False for a public (no-login) generic project; true otherwise. */
    authRequired: boolean;
}

export async function getProjects(): Promise<ProjectView[]> {
    const env = loadEnvConfig();
    const projects = await listProjects();
    return projects.map((p) => {
        const graphPresent = fs.existsSync(path.join(env.outputDir, p.id, "graph", "latest.json"));
        // A generic project's adapter declares whether it needs login (default true);
        // built-in adapters always do.
        const authRequired = p.adapterKind === "generic" ? (p.adapter?.authRequired ?? true) : true;
        // A no-login project needs no credentials, so it is never "missing" them.
        const credsConfigured = !authRequired
            ? true
            : p.adapterKind === "generic"
              ? Boolean(p.adapter && process.env[p.adapter.emailEnv] && process.env[p.adapter.passwordEnv])
              : Boolean(env.email && env.password);
        return { ...p, graphPresent, credsConfigured, authRequired };
    });
}

export async function createProject(body: unknown): Promise<ProjectRecord> {
    const parsed = projectSchema.safeParse(body);
    if (!parsed.success) {
        throw new HttpError(400, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    }
    const d = parsed.data;
    // A built-in adapter uses its (fixed) kind as the id so output paths line up
    // with its adapter; a generic project is keyed by a slug of its repo.
    const id = d.adapterKind === "generic" ? slug(d.repo) : d.adapterKind;

    let adapter: GenericProjectConfig | null = null;
    if (d.adapterKind === "generic" && d.adapter) {
        // Fill in credential env-var NAMES when the form didn't supply them, and force
        // an empty write allow-list for a public project (no auth POST to permit) so the
        // invariant doesn't depend on the client.
        const derived = credEnvNames(d.repo);
        adapter = {
            auth: d.adapter.auth,
            authRequired: d.adapter.authRequired,
            emailEnv: d.adapter.emailEnv || derived.emailEnv,
            passwordEnv: d.adapter.passwordEnv || derived.passwordEnv,
            previewEnvIncludes: d.adapter.previewEnvIncludes,
            pagesPrefix: d.adapter.pagesPrefix,
            knownRoutes: d.adapter.knownRoutes,
            allowedMutationPatterns: d.adapter.authRequired ? d.adapter.allowedMutationPatterns : [],
            productionMarkers: d.adapter.productionMarkers,
            destructiveControlPatterns: d.adapter.destructiveControlPatterns,
        };
    }

    const record: ProjectRecord = {
        id,
        repo: d.repo,
        displayName: d.repo,
        adapterKind: d.adapterKind,
        previewEnvIncludes: d.previewEnvIncludes,
        mentionHandle: d.mentionHandle,
        adapter,
        baselineUrl: d.baselineUrl ?? null,
        createdAt: new Date().toISOString(),
    };
    await upsertProject(record);
    return record;
}

const updateProjectSchema = z.object({ baselineUrl: z.string().url().nullable().optional() });

export async function updateProject(id: string, body: unknown): Promise<ProjectRecord> {
    const project = await getProject(id);
    if (!project) {
        throw new HttpError(404, `Unknown project: ${id}`);
    }
    const parsed = updateProjectSchema.safeParse(body);
    if (!parsed.success) {
        throw new HttpError(400, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    }
    // Only touch baselineUrl when the field is present, so a partial PATCH that omits
    // it doesn't silently wipe the stored URL (null still explicitly clears it).
    const updated: ProjectRecord = { ...project };
    if (parsed.data.baselineUrl !== undefined) {
        updated.baselineUrl = parsed.data.baselineUrl;
    }
    await upsertProject(updated);
    return updated;
}

export async function deleteProject(id: string): Promise<void> {
    await removeProject(id);
}

const crawlOptsSchema = z.object({
    maxPages: z.number().int().positive().max(200).optional(),
    actuationsPerPage: z.number().int().positive().max(50).optional(),
    interact: z.boolean().optional(),
});

export async function triggerCrawl(projectId: string, body: unknown): Promise<{ runId: string; status: string }> {
    const project = await getProject(projectId);
    if (!project) {
        throw new HttpError(404, `Unknown project: ${projectId}`);
    }
    if (isCrawlRunning(projectId)) {
        throw new HttpError(409, `A crawl for ${projectId} is already in progress.`);
    }
    const parsed = crawlOptsSchema.safeParse(body ?? {});
    if (!parsed.success) {
        throw new HttpError(400, "invalid crawl options");
    }
    const runId = triggerCrawlInBackground(project, parsed.data);
    return { runId, status: "running" };
}

const autodetectSchema = z.object({
    repo: z.string().regex(/^[^/\s]+\/[^/\s]+$/, "repo must be owner/name"),
    baselineUrl: z.string().url().nullable().optional(),
    previewEnvIncludes: z.string().optional(),
});

/**
 * Kick off an auto-detect run for a (possibly unregistered) repo. Returns the runId so
 * the client can stream progress and read the proposed config from the SSE `done` event.
 */
export async function triggerAutodetect(body: unknown): Promise<{ runId: string; status: string }> {
    const parsed = autodetectSchema.safeParse(body);
    if (!parsed.success) {
        throw new HttpError(400, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    }
    const { repo, baselineUrl, previewEnvIncludes } = parsed.data;
    if (isAutodetectRunning(repo)) {
        throw new HttpError(409, `Auto-detect for ${repo} is already in progress.`);
    }
    const runId = triggerAutodetectInBackground({ repo, baselineUrl: baselineUrl ?? null, previewEnvIncludes });
    return { runId, status: "running" };
}

/** Adapter kinds the registration form may offer (generic + any registered built-ins). */
export function getAdapters(): { kinds: string[] } {
    return { kinds: adapterKinds() };
}

export async function getRuns(): Promise<RunSummary[]> {
    return indexRuns();
}

export async function getRun(runId: string): Promise<RunRecord | null> {
    return (await listRunRecords()).find((r) => r.runId === runId) ?? null;
}

/** Remove a run from the gallery: drop its RunRecord and delete its on-disk artifacts (if any). */
export async function deleteRun(runId: string): Promise<void> {
    const rec = (await listRunRecords()).find((r) => r.runId === runId);
    let runDir = rec?.runDir ?? null;
    if (!runDir) {
        runDir = (await resolveRunArtifacts(runId))?.runDir ?? null;
    }
    await removeRunRecord(runId);
    if (runDir) {
        // Only ever remove inside the output dir (never follow an id to an arbitrary path).
        const root = path.resolve(loadEnvConfig().outputDir);
        const resolved = path.resolve(runDir);
        if (resolved !== root && resolved.startsWith(root + path.sep)) {
            await fs.promises.rm(resolved, { recursive: true, force: true });
        }
    }
}

export async function triggerVerify(projectId: string, pr: number): Promise<{ runId: string; status: string }> {
    if (!Number.isFinite(pr) || pr <= 0) {
        throw new HttpError(400, "PR number must be a positive integer.");
    }
    const project = await getProject(projectId);
    if (!project) {
        throw new HttpError(404, `Unknown project: ${projectId}`);
    }
    if (isPrRunning(project.repo, pr)) {
        throw new HttpError(409, `A run for ${project.repo}#${pr} is already in progress.`);
    }
    const runId = triggerRunInBackground(project, pr, null);
    return { runId, status: "running" };
}

export async function getHealth(): Promise<{ ghAuthOk: boolean; llmCredOk: boolean; pollerRunning: boolean }> {
    const env = loadEnvConfig();
    return {
        ghAuthOk: await isGhAuthenticated(),
        llmCredOk: llmCredentialIssue(env.llmProvider) === null,
        pollerRunning: isPollerRunning(),
    };
}
