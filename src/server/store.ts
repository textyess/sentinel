import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { loadEnvConfig } from "../index";
import type { MentionLedger, ProjectRecord, RunRecord } from "./types";

/** All server state lives under the same output dir the rest of Sentinel uses. */
function outputDir(): string {
    return loadEnvConfig().outputDir;
}

function projectsFile(): string {
    return path.join(outputDir(), "server", "projects.json");
}

function runsFile(): string {
    return path.join(outputDir(), "server", "runs.json");
}

function ledgerFile(adapterId: string): string {
    return path.join(outputDir(), adapterId, "mentions-handled.json");
}

/** One async mutex per file so concurrent upserts serialize (read-modify-write safety). */
const fileLocks = new Map<string, Promise<unknown>>();
function withLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
    const prev = fileLocks.get(file) ?? Promise.resolve();
    const result = prev.then(fn, fn);
    fileLocks.set(
        file,
        result.then(
            () => undefined,
            () => undefined,
        ),
    );
    return result;
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
    try {
        return JSON.parse(await fsp.readFile(file, "utf8")) as T;
    } catch {
        return fallback;
    }
}

/** Write via tmp + fsync + rename so a crash never leaves a half-written JSON file. */
async function atomicWriteJson(file: string, data: unknown): Promise<void> {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    const handle = await fsp.open(tmp, "w");
    try {
        await handle.writeFile(JSON.stringify(data, null, 2));
        await handle.sync();
    } finally {
        await handle.close();
    }
    await fsp.rename(tmp, file);
}

export async function listProjects(): Promise<ProjectRecord[]> {
    return readJson<ProjectRecord[]>(projectsFile(), []);
}

export async function getProject(id: string): Promise<ProjectRecord | null> {
    return (await listProjects()).find((p) => p.id === id) ?? null;
}

export async function upsertProject(input: ProjectRecord): Promise<void> {
    await withLock(projectsFile(), async () => {
        const list = await readJson<ProjectRecord[]>(projectsFile(), []);
        const idx = list.findIndex((p) => p.id === input.id);
        if (idx >= 0) {
            list[idx] = input;
        } else {
            list.push(input);
        }
        await atomicWriteJson(projectsFile(), list);
    });
}

export async function removeProject(id: string): Promise<void> {
    await withLock(projectsFile(), async () => {
        const list = await readJson<ProjectRecord[]>(projectsFile(), []);
        await atomicWriteJson(
            projectsFile(),
            list.filter((p) => p.id !== id),
        );
    });
}

export async function loadLedger(adapterId: string): Promise<MentionLedger> {
    return readJson<MentionLedger>(ledgerFile(adapterId), { repo: "", lastPolledAt: null, handled: {} });
}

export async function saveLedger(adapterId: string, ledger: MentionLedger): Promise<void> {
    await withLock(ledgerFile(adapterId), async () => {
        await atomicWriteJson(ledgerFile(adapterId), ledger);
    });
}

export async function listRunRecords(): Promise<RunRecord[]> {
    return readJson<RunRecord[]>(runsFile(), []);
}

export async function upsertRunRecord(record: RunRecord): Promise<void> {
    await withLock(runsFile(), async () => {
        const list = await readJson<RunRecord[]>(runsFile(), []);
        const idx = list.findIndex((r) => r.runId === record.runId);
        if (idx >= 0) {
            list[idx] = record;
        } else {
            list.push(record);
        }
        await atomicWriteJson(runsFile(), list);
    });
}

export async function removeRunRecord(runId: string): Promise<void> {
    await withLock(runsFile(), async () => {
        const list = await readJson<RunRecord[]>(runsFile(), []);
        await atomicWriteJson(
            runsFile(),
            list.filter((r) => r.runId !== runId),
        );
    });
}
