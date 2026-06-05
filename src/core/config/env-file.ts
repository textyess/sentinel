import * as fs from "node:fs";
import * as path from "node:path";
import * as dotenv from "dotenv";
import { PACKAGE_ROOT } from "../config";

/**
 * Generic, repo-agnostic .env editing. It writes whatever validated key the caller
 * hands it — the allowlist + secret classification live in the app layer, never here.
 * Carries a KEY NAME only, never a value, so a failed write can't leak a secret to a log.
 */
export class EnvFileWriteError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "EnvFileWriteError";
    }
}

const KEY_RE = /^[A-Z][A-Z0-9_]*$/;

/**
 * Single-quote-wrap a value. Verified against the installed dotenv: inside single
 * quotes bytes are taken literally (#, space, $, ", backslash, = all round-trip).
 * Newlines/CR can't live on a single .env line, so they're rejected.
 */
export function encodeEnvValue(value: string): string {
    if (/[\n\r]/.test(value)) {
        throw new EnvFileWriteError("value contains a newline/carriage-return, which cannot be stored in .env");
    }
    return `'${value}'`;
}

function envLineRegex(key: string): RegExp {
    return new RegExp(`^\\s*(export\\s+)?${key}\\s*=`);
}

function atomicWrite(file: string, content: string): void {
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, file);
}

/**
 * Set (or, with an empty value, remove) one key in a .env file, preserving every
 * other line, comment, and blank verbatim. Before writing a value, a MANDATORY
 * fail-closed round-trip check parses the encoded line with the real dotenv parser
 * and asserts it reads back byte-equal — so a value that can't be stored safely is
 * rejected (key name only) rather than silently corrupting the file.
 */
export function writeEnvFileVar(file: string, key: string, value: string): void {
    if (!KEY_RE.test(key)) {
        throw new EnvFileWriteError(`invalid env key: ${key}`);
    }
    const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    const lines = existing.length > 0 ? existing.split("\n") : [];
    // Drop a trailing empty element from a trailing newline so we control the ending.
    if (lines.length > 0 && lines[lines.length - 1] === "") {
        lines.pop();
    }
    const re = envLineRegex(key);
    // ALL lines defining this key — a hand-edited .env may contain duplicates, and
    // dotenv resolves duplicates to the LAST, so updating only the first would leave
    // a stale trailing line that silently wins on the next load.
    const matchIdx: number[] = [];
    lines.forEach((line, i) => {
        if (re.test(line)) {
            matchIdx.push(i);
        }
    });

    let next: string[];
    if (value === "") {
        if (matchIdx.length === 0) {
            return; // nothing to remove
        }
        next = lines.filter((_, i) => !matchIdx.includes(i));
    } else {
        const encoded = encodeEnvValue(value);
        const parsed = dotenv.parse(`${key}=${encoded}`)[key];
        if (parsed !== value) {
            throw new EnvFileWriteError(`value for ${key} cannot be safely encoded for .env`);
        }
        const first = matchIdx[0];
        if (first === undefined) {
            next = [...lines, `${key}=${encoded}`];
        } else {
            // Replace the first occurrence in place (preserving any `export ` prefix),
            // and drop every later duplicate.
            const exportPrefix = /^\s*export\s+/.exec(lines[first] ?? "")?.[0] ?? "";
            const replacement = `${exportPrefix}${key}=${encoded}`;
            next = lines
                .map((line, i) => (i === first ? replacement : line))
                .filter((_, i) => i === first || !matchIdx.includes(i));
        }
    }
    atomicWrite(file, next.length > 0 ? `${next.join("\n")}\n` : "");
}

/**
 * Persist a key to the package .env AND apply it to the live process. Persist FIRST,
 * then mutate process.env only on a successful write — so a failed write can never
 * leave the running process ahead of disk (a later restart would silently revert it).
 * An empty value removes the key from both.
 */
export function applyEnvVar(key: string, value: string): void {
    writeEnvFileVar(path.join(PACKAGE_ROOT, ".env"), key, value);
    if (value === "") {
        delete process.env[key];
    } else {
        process.env[key] = value;
    }
}
