import { AsyncLocalStorage } from "node:async_hooks";
import { SENTINEL } from "../persona";

type Level = "info" | "warn" | "error" | "success" | "debug";

/** One log line, fanned out to a run's subscribers (e.g. an SSE stream). */
export interface LogLine {
    runId: string;
    level: Level;
    message: string;
    at: string;
}

type Sink = (line: LogLine) => void;

/**
 * Per-run progress plumbing. Logging stays a global singleton writing to
 * stdout/stderr; ADDITIONALLY, when code runs inside {@link runWithProgress},
 * every emitted line is forwarded to that run's sinks. This lets the server
 * stream a run's progress to a browser without threading a logger through the
 * ~10 core call sites.
 */
const runScope = new AsyncLocalStorage<{ runId: string }>();
const sinkMap = new Map<string, Set<Sink>>();

export function runWithProgress<T>(runId: string, fn: () => Promise<T>): Promise<T> {
    return runScope.run({ runId }, fn);
}

export function addProgressSink(runId: string, sink: Sink): () => void {
    let set = sinkMap.get(runId);
    if (!set) {
        set = new Set();
        sinkMap.set(runId, set);
    }
    set.add(sink);
    return () => {
        const current = sinkMap.get(runId);
        if (!current) {
            return;
        }
        current.delete(sink);
        if (current.size === 0) {
            sinkMap.delete(runId);
        }
    };
}

function fanOut(level: Level, message: string): void {
    const store = runScope.getStore();
    if (!store) {
        return;
    }
    const sinks = sinkMap.get(store.runId);
    if (!sinks) {
        return;
    }
    const line: LogLine = { runId: store.runId, level, message, at: new Date().toISOString() };
    for (const sink of sinks) {
        try {
            sink(line);
        } catch {
            // A subscriber must never break logging.
        }
    }
}

const ESC = String.fromCharCode(27);

const ANSI = {
    reset: `${ESC}[0m`,
    dim: `${ESC}[2m`,
    red: `${ESC}[31m`,
    green: `${ESC}[32m`,
    yellow: `${ESC}[33m`,
    blue: `${ESC}[34m`,
    cyan: `${ESC}[36m`,
} as const;

const LEVEL_COLOR: Record<Level, string> = {
    info: ANSI.cyan,
    warn: ANSI.yellow,
    error: ANSI.red,
    success: ANSI.green,
    debug: ANSI.dim,
};

const DEBUG_ENABLED = ["1", "true", "yes", "on"].includes((process.env.SENTINEL_DEBUG ?? "").toLowerCase());

function emit(level: Level, message: string): void {
    if (level === "debug" && !DEBUG_ENABLED) {
        return;
    }
    const color = LEVEL_COLOR[level];
    const prefix = `${ANSI.dim}${SENTINEL.glyph} ${SENTINEL.name}${ANSI.reset}`;
    const line = `${prefix} ${color}${message}${ANSI.reset}`;
    if (level === "error") {
        process.stderr.write(`${line}\n`);
    } else {
        process.stdout.write(`${line}\n`);
    }
    fanOut(level, message);
}

export const logger = {
    info: (message: string) => emit("info", message),
    warn: (message: string) => emit("warn", message),
    error: (message: string) => emit("error", message),
    success: (message: string) => emit("success", message),
    debug: (message: string) => emit("debug", message),
    /** A short banner used at the start of a run. */
    banner: (subtitle: string) => {
        process.stdout.write(
            `\n${ANSI.cyan}${SENTINEL.glyph} ${SENTINEL.name}${ANSI.reset} ${ANSI.dim}- ${subtitle}${ANSI.reset}\n\n`,
        );
    },
};
