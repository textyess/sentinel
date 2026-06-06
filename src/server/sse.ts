import type { Verdict } from "../index";
import { addProgressSink, redactSecret } from "../index";
import { singleton } from "./singleton";
import type { AutodetectProposal } from "./types";

/** A transport sink — the SSE route enqueues each chunk into its response stream. */
type Writer = (chunk: string) => void;

/**
 * In-memory SSE hub keyed by runId. Subscribes to the logger fan-out so a run's
 * progress lines stream to any connected browser. A short ring buffer per run
 * lets a mid-run connection catch up. Every line is redacted before it leaves.
 */
const RING = 250;
const buffers = singleton("sse.buffers", () => new Map<string, string[]>());
const writers = singleton("sse.writers", () => new Map<string, Set<Writer>>());
const unsubscribers = singleton("sse.unsubscribers", () => new Map<string, () => void>());

function buffer(runId: string, chunk: string): void {
    let b = buffers.get(runId);
    if (!b) {
        b = [];
        buffers.set(runId, b);
    }
    b.push(chunk);
    if (b.length > RING) {
        b.shift();
    }
}

function broadcast(runId: string, chunk: string): void {
    const set = writers.get(runId);
    if (!set) {
        return;
    }
    for (const write of set) {
        try {
            write(chunk);
        } catch {
            // a dead subscriber is removed by its own cleanup
        }
    }
}

function emit(runId: string, chunk: string): void {
    buffer(runId, chunk);
    broadcast(runId, chunk);
}

function progressChunk(level: string, message: string, at: string): string {
    return `event: progress\ndata: ${JSON.stringify({ level, message: redactSecret(message), at })}\n\n`;
}

/** Attach a logger sink for this run the first time anyone cares about it. */
function ensureSink(runId: string): void {
    if (unsubscribers.has(runId)) {
        return;
    }
    const unsub = addProgressSink(runId, (line) => {
        emit(runId, progressChunk(line.level, line.message, line.at));
    });
    unsubscribers.set(runId, unsub);
}

/**
 * Attach a writer to a run's stream. Replays the ring buffer immediately so a mid-run
 * connection catches up, sends a periodic heartbeat, and returns a cleanup the transport
 * (the SSE route) calls when the client disconnects.
 */
export function subscribe(runId: string, write: Writer): () => void {
    ensureSink(runId);
    for (const chunk of buffers.get(runId) ?? []) {
        write(chunk);
    }
    let set = writers.get(runId);
    if (!set) {
        set = new Set();
        writers.set(runId, set);
    }
    set.add(write);

    let heartbeat: ReturnType<typeof setInterval>;
    const cleanup = (): void => {
        clearInterval(heartbeat);
        const current = writers.get(runId);
        if (current) {
            current.delete(write);
            if (current.size === 0) {
                writers.delete(runId);
            }
        }
    };
    heartbeat = setInterval(() => {
        try {
            write(":\n\n");
        } catch {
            // a disconnect that never surfaced as abort/cancel — self-clean so the
            // interval can't leak on a half-open connection.
            cleanup();
        }
    }, 15000);
    return cleanup;
}

/** Detach the logger sink for a finished run (the ring buffer is kept for late connects). */
function releaseSink(runId: string): void {
    const unsub = unsubscribers.get(runId);
    if (unsub) {
        unsub();
        unsubscribers.delete(runId);
    }
}

export function publishDone(runId: string, payload: { verdict: Verdict; videoUrl: string | null }): void {
    // The verdict is free LLM text built from the PR body — redact before it leaves the process.
    const safe = {
        verdict: {
            ...payload.verdict,
            summary: redactSecret(payload.verdict.summary),
            evidence: payload.verdict.evidence.map(redactSecret),
        },
        videoUrl: payload.videoUrl,
    };
    emit(runId, `event: done\ndata: ${JSON.stringify(safe)}\n\n`);
    releaseSink(runId);
}

export function publishError(runId: string, message: string): void {
    emit(runId, `event: error\ndata: ${JSON.stringify({ message: redactSecret(message) })}\n\n`);
    releaseSink(runId);
}

/**
 * Terminal event for an auto-detect run — the proposed config the dashboard pre-fills.
 * Free-text notes are redacted; emailEnv/passwordEnv are env-var names, not secrets.
 */
export function publishAutodetectDone(runId: string, proposal: AutodetectProposal): void {
    const safe: AutodetectProposal = { ...proposal, notes: proposal.notes.map(redactSecret) };
    emit(runId, `event: done\ndata: ${JSON.stringify({ kind: "autodetect", proposal: safe })}\n\n`);
    releaseSink(runId);
}

/** Terminal event for a baseline crawl — integer coverage counts only, never a verdict or secret. */
export function publishCrawlDone(
    runId: string,
    payload: {
        coverage: { nodeCount: number; edgeCount: number; routesReached: number; routesUnreached: number };
        graphPresent: true;
    },
): void {
    emit(runId, `event: done\ndata: ${JSON.stringify({ kind: "crawl", ...payload })}\n\n`);
    releaseSink(runId);
}
