import { type ChildProcess, spawn } from "node:child_process";
import { logger } from "../logger";
import { redactSecret } from "../safety/redact";
import { ensureAppReachable } from "./app";
import { DEFAULT_INSTALL_TIMEOUT_MS, DEFAULT_READY_PATH, DEFAULT_READY_TIMEOUT_MS, type RunRecipe } from "./recipe";

/**
 * Non-secret host env vars safe to hand to a spawned target app. Sentinel's own
 * secrets — the GitHub token, LLM API keys, every SENTINEL_*, and other projects'
 * credentials — are deliberately NOT forwarded. Running a PR branch executes
 * attacker-influenced install/build/run scripts, so the child only ever sees this
 * allowlist plus the recipe's own declared env. This is the cheapest, most important
 * isolation measure short of a per-run sandbox.
 */
const HOST_ENV_ALLOWLIST = [
    "PATH",
    "HOME",
    "USER",
    "SHELL",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TZ",
    "TMPDIR",
    "TEMP",
    "TMP",
    "TERM",
    "SystemRoot",
    "windir",
];

const LOG_TAIL_BYTES = 64 * 1024;

/** A running, locally-started app the verify flow can drive, plus its teardown handle. */
export interface LaunchedApp {
    /** e.g. http://127.0.0.1:3000 — hand this to the browser as baseUrl. */
    baseUrl: string;
    /** Stop the app and reap its whole process tree. Idempotent. */
    stop(): Promise<void>;
    /** Redacted tail of the app's stdout+stderr, for diagnostics. */
    logs(): string;
}

export interface LaunchOptions {
    /** Working directory holding the checked-out app (typically a PR worktree). */
    cwd: string;
    /** Host the app binds to and Sentinel probes. Default 127.0.0.1. */
    host?: string;
}

// Returns ProcessEnv (asserted) so it slots into spawn; built from a bare record because
// NODE_ENV is deliberately NOT forwarded — the container's `production` would break a `dev` run.
function buildChildEnv(recipe: RunRecipe): NodeJS.ProcessEnv {
    const base: Record<string, string> = {};
    for (const key of HOST_ENV_ALLOWLIST) {
        const value = process.env[key];
        if (value !== undefined) {
            base[key] = value;
        }
    }
    // The port is the contract between Sentinel and the app — most frameworks read PORT.
    base.PORT = String(recipe.port);
    // The recipe's declared env wins (and may override PORT for frameworks that don't read it).
    return { ...base, ...(recipe.env ?? {}) } as NodeJS.ProcessEnv;
}

function makeLogBuffer(): { append(chunk: string): void; read(): string } {
    let buf = "";
    return {
        append(chunk: string): void {
            buf += chunk;
            if (buf.length > LOG_TAIL_BYTES) {
                buf = buf.slice(buf.length - LOG_TAIL_BYTES);
            }
        },
        read(): string {
            return redactSecret(buf);
        },
    };
}

/** Run a one-shot command (e.g. install) to completion; reject on non-zero exit or timeout. */
function runToCompletion(
    cmd: string,
    opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; label: string },
): Promise<void> {
    return new Promise((resolve, reject) => {
        const log = makeLogBuffer();
        // detached so a timeout can SIGKILL the whole group — `npm/pnpm/yarn install` runs as
        // grandchildren of the shell, and killing only the shell would orphan them downloading
        // into a worktree we're about to remove.
        const child = spawn(cmd, { cwd: opts.cwd, env: opts.env, shell: true, detached: true });
        const timer = setTimeout(() => {
            if (child.pid !== undefined) {
                killTree(child.pid, "SIGKILL");
            } else {
                child.kill("SIGKILL");
            }
            reject(new Error(`${opts.label} timed out after ${opts.timeoutMs}ms.\n${log.read()}`));
        }, opts.timeoutMs);
        const onData = (data: Buffer): void => {
            const text = String(data);
            log.append(text);
            logger.debug(`[${opts.label}] ${redactSecret(text).trimEnd()}`);
        };
        child.stdout?.on("data", onData);
        child.stderr?.on("data", onData);
        child.on("error", (err) => {
            clearTimeout(timer);
            reject(new Error(`${opts.label} failed to start: ${err.message}`));
        });
        child.on("exit", (code) => {
            clearTimeout(timer);
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`${opts.label} exited with code ${code}.\n${log.read()}`));
            }
        });
    });
}

/**
 * Signal a detached child's whole process group. `runCmd` (e.g. `npm run dev`) spawns
 * grandchildren that actually hold the port; killing only the shell leaves the server
 * running, so we signal the negative pid (the group) and fall back to the bare pid.
 */
function killTree(pid: number, signal: NodeJS.Signals): void {
    try {
        process.kill(-pid, signal);
    } catch {
        try {
            process.kill(pid, signal);
        } catch {
            // Already gone.
        }
    }
}

function makeStop(child: ChildProcess): () => Promise<void> {
    let stopped = false;
    return async (): Promise<void> => {
        if (stopped) {
            return;
        }
        stopped = true;
        const pid = child.pid;
        if (pid === undefined) {
            return;
        }
        // The leader (shell) may have exited while detached grandchildren still hold the
        // port, so issue the group kill based on the pid regardless of the leader's own
        // exit state — killTree swallows ESRCH when the group is genuinely empty.
        const exited =
            child.exitCode !== null || child.signalCode !== null
                ? Promise.resolve()
                : new Promise<void>((resolve) => child.once("exit", () => resolve()));
        killTree(pid, "SIGTERM");
        const escalate = setTimeout(() => killTree(pid, "SIGKILL"), 5000);
        // Never let teardown hang the run, even if the exit event is missed.
        await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 8000))]);
        clearTimeout(escalate);
    };
}

/**
 * Start a target app from a checked-out branch and wait until it answers HTTP. On
 * failure the app is torn down and the error carries the redacted log tail so the
 * caller can show why bring-up failed. The returned {@link LaunchedApp.stop} MUST be
 * called when the run finishes.
 */
export async function launchLocalApp(recipe: RunRecipe, opts: LaunchOptions): Promise<LaunchedApp> {
    const host = opts.host ?? "127.0.0.1";
    const env = buildChildEnv(recipe);
    const readyPath = recipe.readyPath ?? DEFAULT_READY_PATH;
    const baseUrl = `http://${host}:${recipe.port}`;
    const probeUrl = `${baseUrl}${readyPath.startsWith("/") ? readyPath : `/${readyPath}`}`;

    if (recipe.installCmd) {
        logger.info(`Installing dependencies: ${recipe.installCmd}`);
        await runToCompletion(recipe.installCmd, {
            cwd: opts.cwd,
            env,
            timeoutMs: recipe.installTimeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS,
            label: "install",
        });
    }

    logger.info(`Starting app: ${recipe.runCmd}`);
    const log = makeLogBuffer();
    const child = spawn(recipe.runCmd, { cwd: opts.cwd, env, shell: true, detached: true });
    const onData = (data: Buffer): void => {
        const text = String(data);
        log.append(text);
        logger.debug(`[app] ${redactSecret(text).trimEnd()}`);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);

    let exited: { code: number | null; signal: NodeJS.Signals | null } | null = null;
    child.on("exit", (code, signal) => {
        exited = { code, signal };
    });
    child.on("error", (err) => {
        log.append(`spawn error: ${err.message}`);
    });

    const stop = makeStop(child);

    try {
        await ensureAppReachable(probeUrl, recipe.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS, () =>
            exited ? `process exited (code ${exited.code}, signal ${exited.signal})` : null,
        );
    } catch (error) {
        await stop();
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`Local bring-up failed.\n${reason}\n--- app logs (tail) ---\n${log.read()}`);
    }

    logger.success(`App is up at ${baseUrl}`);
    return { baseUrl, stop, logs: () => log.read() };
}
