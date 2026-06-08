import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import type { GenericProjectConfig } from "../adapters/generic";
import type { StepResult, VerifyManifest } from "../index";
import {
    adapterKinds,
    buildPortablePack,
    isAdapterKind,
    isGhAuthenticated,
    isReservedSecretEnvName,
    llmCredentialIssue,
    loadEnvConfig,
} from "../index";
import { HttpError } from "./errors";
import { assertWithin } from "./files";
import { indexRuns, resolveRunArtifacts, screenshotUrl, statusFromOutcome, videoUrl } from "./indexer";
import { credEnvNames, slug } from "./naming";
import { isPollerRunning } from "./poller";
import {
    isAutodetectRunning,
    isCrawlRunning,
    isPrRunning,
    isSkillsRunning,
    isTrialRunning,
    triggerAutodetectInBackground,
    triggerCrawlInBackground,
    triggerRunInBackground,
    triggerSkillsInBackground,
    triggerTrialBringUpInBackground,
} from "./runner";
import { getProject, listProjects, listRunRecords, removeProject, removeRunRecord, upsertProject } from "./store";
import { tarGzip } from "./targz";
import type { ProjectRecord, RunManifestView, RunRecord, RunSummary, StepResultView } from "./types";

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

// How to start the app locally for repos with no PR preview. Secrets are referenced by
// env-var NAME (resolved from Sentinel's managed env at launch), never stored raw here.
const envVarName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "must be a valid env var name");
// A recipe's secretEnv resolves these names out of Sentinel's process.env into the spawned
// PR app, so it must never reference Sentinel's OWN credentials — reject those at the door.
const secretEnvName = envVarName.refine(
    (n) => !isReservedSecretEnvName(n),
    "must not name a Sentinel secret (SENTINEL_*, AWS_*, GH_TOKEN, GITHUB_TOKEN, ANTHROPIC_API_KEY, OPENAI_API_KEY)",
);
const runRecipeSchema = z.object({
    installCmd: z.string().min(1).optional(),
    runCmd: z.string().min(1),
    port: z.number().int().positive().max(65535),
    readyPath: z.string().optional(),
    env: z.record(z.string(), z.string()).optional(),
    secretEnv: z.array(secretEnvName).optional(),
    installTimeoutMs: z.number().int().positive().optional(),
    readyTimeoutMs: z.number().int().positive().optional(),
});

const projectSchema = z
    .object({
        repo: z.string().regex(/^[^/\s]+\/[^/\s]+$/, "repo must be owner/name"),
        adapterKind: z.string().refine(isAdapterKind, "unknown adapter kind"),
        previewEnvIncludes: z.string().default("web"),
        mentionHandle: z.string().default("@sentinel"),
        baselineUrl: z.string().url().nullable().optional(),
        adapter: genericAdapterSchema.nullable().optional(),
        runRecipe: runRecipeSchema.nullable().optional(),
    })
    .refine((d) => d.adapterKind !== "generic" || Boolean(d.adapter), {
        message: "generic projects require an adapter config",
        path: ["adapter"],
    });

export interface ProjectView extends ProjectRecord {
    graphPresent: boolean;
    credsConfigured: boolean;
    /** True when a generated skill pack exists on disk (so it can be exported). */
    skillsPresent: boolean;
    /** False for a public (no-login) generic project; true otherwise. */
    authRequired: boolean;
}

export async function getProjects(): Promise<ProjectView[]> {
    const env = loadEnvConfig();
    const projects = await listProjects();
    return projects.map((p) => {
        const graphPresent = fs.existsSync(path.join(env.outputDir, p.id, "graph", "latest.json"));
        const skillsPresent = fs.existsSync(path.join(env.outputDir, p.id, "skills", "pack.json"));
        // A generic project's adapter declares whether it needs login (default true);
        // built-in adapters always do.
        const authRequired = p.adapterKind === "generic" ? (p.adapter?.authRequired ?? true) : true;
        // A no-login project needs no credentials, so it is never "missing" them.
        const credsConfigured = !authRequired
            ? true
            : p.adapterKind === "generic"
              ? Boolean(
                    p.adapter &&
                        (process.env[p.adapter.emailEnv] || env.email) &&
                        (process.env[p.adapter.passwordEnv] || env.password),
                )
              : Boolean(env.email && env.password);
        return { ...p, graphPresent, credsConfigured, skillsPresent, authRequired };
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
        runRecipe: d.runRecipe ?? null,
        createdAt: new Date().toISOString(),
    };
    await upsertProject(record);
    return record;
}

const updateProjectSchema = z.object({
    baselineUrl: z.string().url().nullable().optional(),
    runRecipe: runRecipeSchema.nullable().optional(),
});

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
    if (parsed.data.runRecipe !== undefined) {
        updated.runRecipe = parsed.data.runRecipe;
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

/** Author (or re-author) the navigation skill pack for a project in the background. */
export async function triggerSkills(projectId: string): Promise<{ runId: string; status: string }> {
    const project = await getProject(projectId);
    if (!project) {
        throw new HttpError(404, `Unknown project: ${projectId}`);
    }
    if (isSkillsRunning(projectId)) {
        throw new HttpError(409, `Skill authoring for ${projectId} is already in progress.`);
    }
    const runId = triggerSkillsInBackground(project);
    return { runId, status: "running" };
}

/** Build a portable `.tar.gz` of a project's skill pack for download. */
export async function exportSkillsArchive(projectId: string): Promise<{ filename: string; body: Buffer }> {
    const project = await getProject(projectId);
    if (!project) {
        throw new HttpError(404, `Unknown project: ${projectId}`);
    }
    let files: ReturnType<typeof buildPortablePack>;
    try {
        files = buildPortablePack(loadEnvConfig().outputDir, project.id);
    } catch {
        // The only expected failure is "no pack yet" — surface it as a clean 409.
        throw new HttpError(409, "No skill pack to export yet. Generate skills for this project first.");
    }
    // Nest under a single folder so extraction yields one clean directory.
    const root = `${project.id}-skills`;
    const body = tarGzip(
        files.map((f) => ({ name: `${root}/${f.name}`, content: f.content })),
        Math.floor(Date.now() / 1000),
    );
    return { filename: `${root}.tar.gz`, body };
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

const trialBringUpSchema = z.object({
    repo: z.string().regex(/^[^/\s]+\/[^/\s]+$/, "repo must be owner/name"),
    runRecipe: runRecipeSchema,
});

/**
 * "Prove it" check for a (possibly unregistered) repo: clone the default branch, run the
 * recipe, confirm the app answers HTTP, tear down. Returns a runId so the client can stream
 * progress and read the pass/fail from the SSE `done` event before registering.
 */
export async function triggerTrialBringUp(body: unknown): Promise<{ runId: string; status: string }> {
    const parsed = trialBringUpSchema.safeParse(body);
    if (!parsed.success) {
        throw new HttpError(400, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    }
    if (isTrialRunning(parsed.data.repo)) {
        throw new HttpError(409, `A trial bring-up for ${parsed.data.repo} is already in progress.`);
    }
    const runId = triggerTrialBringUpInBackground(parsed.data);
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

function toStepResultView(runId: string, r: StepResult): StepResultView {
    return {
        index: r.index,
        step: r.step,
        status: r.status,
        observation: r.observation,
        screenshotUrl: r.screenshot ? screenshotUrl(runId, r.screenshot) : null,
        consoleErrors: r.consoleErrors,
        networkErrors: r.networkErrors,
        ...(r.discrepancies ? { discrepancies: r.discrepancies } : {}),
        // Older manifests predate timeline tracking — surface null so the player falls back gracefully.
        startMs: r.startMs ?? null,
        endMs: r.endMs ?? null,
    };
}

/**
 * The full report for one verify run: its plan, per-step results, verdict, and video,
 * read from the on-disk manifest and sanitized for the browser (no absolute paths).
 * Returns null when the run has no manifest yet (still running, crawl/autodetect, or unknown).
 */
export async function getRunManifest(runId: string): Promise<RunManifestView | null> {
    const artifacts = await resolveRunArtifacts(runId);
    if (!artifacts?.manifestPath) {
        return null;
    }
    // An id must never address a file outside the run output dir.
    const safe = assertWithin(loadEnvConfig().outputDir, artifacts.manifestPath);
    let manifest: VerifyManifest;
    try {
        manifest = JSON.parse(await fs.promises.readFile(safe, "utf8")) as VerifyManifest;
    } catch {
        return null;
    }
    // The RunRecord (when present) is authoritative for repo/project/live status; a
    // manifest-only (CLI) run is keyed `<adapterId>__<dirName>`, so fall back to that.
    const record = (await listRunRecords()).find((r) => r.runId === runId) ?? null;
    const sep = runId.indexOf("__");
    const adapterId = sep > 0 ? runId.slice(0, sep) : (record?.projectId ?? runId);
    return {
        runId,
        projectId: record?.projectId ?? adapterId,
        repo: record?.repo ?? adapterId,
        pr: manifest.pr,
        title: manifest.title,
        body: manifest.body,
        headSha: manifest.headSha,
        headRef: manifest.headRef,
        targetUrl: manifest.targetUrl,
        changedFiles: manifest.changedFiles,
        affectedRoutes: manifest.affectedRoutes,
        readOnly: manifest.readOnly,
        blockedWrites: manifest.blockedWrites,
        model: manifest.model,
        plan: manifest.plan,
        results: manifest.results.map((r) => toStepResultView(runId, r)),
        verdict: manifest.verdict,
        videoUrl: videoUrl(runId, Boolean(manifest.video)),
        createdAt: manifest.createdAt,
        status: record?.status ?? statusFromOutcome(manifest.verdict.outcome),
    };
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
