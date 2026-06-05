import type { ServerResponse } from "node:http";
import type { Verdict } from "../index";
import { addProgressSink, redactSecret } from "../index";

/**
 * In-memory SSE hub keyed by runId. Subscribes to the logger fan-out so a run's
 * progress lines stream to any connected browser. A short ring buffer per run
 * lets a mid-run connection catch up. Every line is redacted before it leaves.
 */
const RING = 250;
const buffers = new Map<string, string[]>();
const responses = new Map<string, Set<ServerResponse>>();
const unsubscribers = new Map<string, () => void>();

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
    const set = responses.get(runId);
    if (!set) {
        return;
    }
    for (const res of set) {
        try {
            res.write(chunk);
        } catch {
            // a dead connection is cleaned up on its own 'close' event
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

export function subscribe(runId: string, res: ServerResponse): () => void {
    res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
    });
    ensureSink(runId);
    for (const chunk of buffers.get(runId) ?? []) {
        res.write(chunk);
    }
    let set = responses.get(runId);
    if (!set) {
        set = new Set();
        responses.set(runId, set);
    }
    set.add(res);

    const heartbeat = setInterval(() => {
        try {
            res.write(":\n\n");
        } catch {
            // cleaned up on 'close'
        }
    }, 15000);

    const cleanup = (): void => {
        clearInterval(heartbeat);
        const current = responses.get(runId);
        if (current) {
            current.delete(res);
            if (current.size === 0) {
                responses.delete(runId);
            }
        }
    };
    res.on("close", cleanup);
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
