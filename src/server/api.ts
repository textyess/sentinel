import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { isGhAuthenticated, llmCredentialIssue, loadEnvConfig } from "../index";
import { HttpError } from "./errors";
import { indexRuns, resolveRunArtifacts } from "./indexer";
import { isPollerRunning } from "./poller";
import { isCrawlRunning, isPrRunning, triggerCrawlInBackground, triggerRunInBackground } from "./runner";
import { getProject, listProjects, listRunRecords, removeProject, removeRunRecord, upsertProject } from "./store";
import type { ProjectRecord, RunRecord, RunSummary } from "./types";

const authSchema = z.object({
    loginPath: z.string().min(1),
    emailLabel: z.string().min(1),
    passwordLabel: z.string().min(1),
    submitNamePattern: z.string().min(1),
    authenticatedUrlPattern: z.string().min(1),
    emailFallbackSelector: z.string().optional(),
    passwordFallbackSelector: z.string().optional(),
    publicRoutes: z.array(z.string()).default([]),
});

const genericAdapterSchema = z.object({
    auth: authSchema,
    emailEnv: z.string().min(1),
    passwordEnv: z.string().min(1),
    previewEnvIncludes: z.string().default("web"),
    pagesPrefix: z.string().optional(),
    knownRoutes: z.array(z.string()).optional(),
    // Must be anchored (auth paths only) so a broad operator-supplied pattern can't
    // punch a wide write hole through the read-only guard.
    allowedMutationPatterns: z
        .array(z.string().regex(/^\^/, "each pattern must be anchored with ^ (auth paths only)"))
        .default([]),
    productionMarkers: z.array(z.string()).optional(),
    destructiveControlPatterns: z.array(z.string()).optional(),
});

const projectSchema = z
    .object({
        repo: z.string().regex(/^[^/\s]+\/[^/\s]+$/, "repo must be owner/name"),
        adapterKind: z.enum(["textyess", "generic"]),
        previewEnvIncludes: z.string().default("web"),
        mentionHandle: z.string().default("@sentinel"),
        baselineUrl: z.string().url().nullable().optional(),
        adapter: genericAdapterSchema.nullable().optional(),
    })
    .refine((d) => d.adapterKind === "textyess" || Boolean(d.adapter), {
        message: "generic projects require an adapter config",
        path: ["adapter"],
    });

function slug(repo: string): string {
    return repo
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
}

export interface ProjectView extends ProjectRecord {
    graphPresent: boolean;
    credsConfigured: boolean;
}

export async function getProjects(): Promise<ProjectView[]> {
    const env = loadEnvConfig();
    const projects = await listProjects();
    return projects.map((p) => {
        const graphPresent = fs.existsSync(path.join(env.outputDir, p.id, "graph", "latest.json"));
        const credsConfigured =
            p.adapterKind === "textyess"
                ? Boolean(env.email && env.password)
                : Boolean(p.adapter && process.env[p.adapter.emailEnv] && process.env[p.adapter.passwordEnv]);
        return { ...p, graphPresent, credsConfigured };
    });
}

export async function createProject(body: unknown): Promise<ProjectRecord> {
    const parsed = projectSchema.safeParse(body);
    if (!parsed.success) {
        throw new HttpError(400, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    }
    const d = parsed.data;
    // textyess uses its fixed adapter id so paths line up with createTextyessAdapter.
    const id = d.adapterKind === "textyess" ? "textyess" : slug(d.repo);
    const record: ProjectRecord = {
        id,
        repo: d.repo,
        displayName: d.repo,
        adapterKind: d.adapterKind,
        previewEnvIncludes: d.previewEnvIncludes,
        mentionHandle: d.mentionHandle,
        adapter: d.adapterKind === "generic" ? (d.adapter ?? null) : null,
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
