import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { VerifyManifest } from "../index";
import { loadEnvConfig } from "../index";
import { listRunRecords } from "./store";
import type { RunRecord, RunStatus, RunSummary } from "./types";

function outputDir(): string {
    return loadEnvConfig().outputDir;
}

function statusFromOutcome(outcome: VerifyManifest["verdict"]["outcome"]): RunStatus {
    if (outcome === "pass") {
        return "passed";
    }
    if (outcome === "fail") {
        return "failed";
    }
    return "uncertain";
}

async function readManifest(file: string): Promise<VerifyManifest | null> {
    try {
        return JSON.parse(await fsp.readFile(file, "utf8")) as VerifyManifest;
    } catch {
        return null;
    }
}

/** Manifest-only (e.g. CLI-produced) runs get a path-derived id: `<adapterId>__<dirName>`. */
function manifestRunId(adapterId: string, dirName: string): string {
    return `${adapterId}__${dirName}`;
}

function videoUrl(runId: string, hasVideo: boolean): string | null {
    return hasVideo ? `/api/runs/${encodeURIComponent(runId)}/video` : null;
}

function recordToSummary(r: RunRecord): RunSummary {
    return {
        runId: r.runId,
        projectId: r.projectId,
        repo: r.repo,
        pr: r.pr,
        title: r.title,
        outcome: r.verdict?.outcome ?? null,
        confidence: r.verdict?.confidence ?? null,
        summary: r.verdict?.summary ?? r.error ?? "",
        videoUrl: videoUrl(r.runId, Boolean(r.videoPath)),
        createdAt: r.startedAt,
        status: r.status,
    };
}

function manifestToSummary(adapterId: string, dirName: string, m: VerifyManifest): RunSummary {
    const runId = manifestRunId(adapterId, dirName);
    return {
        runId,
        projectId: adapterId,
        repo: adapterId,
        pr: m.pr,
        title: m.title,
        outcome: m.verdict.outcome,
        confidence: m.verdict.confidence,
        summary: m.verdict.summary,
        videoUrl: videoUrl(runId, Boolean(m.video)),
        createdAt: m.createdAt,
        status: statusFromOutcome(m.verdict.outcome),
    };
}

async function listDirNames(dir: string): Promise<string[]> {
    try {
        return (await fsp.readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
        return [];
    }
}

/**
 * The gallery feed. Live RunRecords win for in-flight status; finished verify-runs
 * are picked up by scanning manifests (covers CLI runs and survives a lost runs.json).
 * Newest first. Absolute video paths become `/api/runs/:runId/video` URLs.
 */
export async function indexRuns(): Promise<RunSummary[]> {
    const records = await listRunRecords();
    const recordDirs = new Set(records.map((r) => r.runDir).filter((d): d is string => Boolean(d)));
    // Crawl runs have no verdict/video — keep them out of the verdict gallery.
    const summaries: RunSummary[] = records.filter((r) => (r.kind ?? "verify") !== "crawl").map(recordToSummary);

    const root = outputDir();
    for (const adapterId of await listDirNames(root)) {
        if (adapterId === "server") {
            continue;
        }
        const verifyRunsDir = path.join(root, adapterId, "verify-runs");
        for (const dirName of await listDirNames(verifyRunsDir)) {
            const dir = path.join(verifyRunsDir, dirName);
            if (recordDirs.has(dir)) {
                continue;
            }
            const manifest = await readManifest(path.join(dir, "manifest.json"));
            if (manifest) {
                summaries.push(manifestToSummary(adapterId, dirName, manifest));
            }
        }
    }

    summaries.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    return summaries;
}

export interface RunArtifacts {
    runDir: string | null;
    videoPath: string | null;
    manifestPath: string | null;
}

/**
 * Resolve a runId to its on-disk artifacts, statelessly. RunRecords are
 * authoritative; otherwise the id is treated as `<adapterId>__<dirName>` and the
 * manifest in that run directory is read. Callers MUST still assert the returned
 * path is within outputDir before serving it.
 */
export async function resolveRunArtifacts(runId: string): Promise<RunArtifacts | null> {
    const rec = (await listRunRecords()).find((r) => r.runId === runId);
    if (rec) {
        return { runDir: rec.runDir, videoPath: rec.videoPath, manifestPath: rec.manifestPath };
    }
    const idx = runId.indexOf("__");
    if (idx <= 0) {
        return null;
    }
    const adapterId = runId.slice(0, idx);
    const dirName = runId.slice(idx + 2);
    const runDir = path.join(outputDir(), adapterId, "verify-runs", dirName);
    const manifestPath = path.join(runDir, "manifest.json");
    if (!fs.existsSync(manifestPath)) {
        return null;
    }
    const manifest = await readManifest(manifestPath);
    return { runDir, videoPath: manifest?.video ?? null, manifestPath };
}
