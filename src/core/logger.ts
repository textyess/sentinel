import { SENTINEL } from "../persona";

type Level = "info" | "warn" | "error" | "success" | "debug";

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
