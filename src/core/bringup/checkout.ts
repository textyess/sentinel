import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import { logger } from "../logger";

const run = promisify(execFile);
const MAX_BUFFER = 64 * 1024 * 1024;

/** A disposable working tree of a PR branch, plus its teardown handle. */
export interface PrCheckout {
    /** Absolute path to the checked-out source. */
    dir: string;
    /** Remove the working tree. Idempotent; never throws. */
    cleanup(): Promise<void>;
}

function makeDir(root: string, prefix: string): { dir: string; cleanup(): Promise<void> } {
    fs.mkdirSync(root, { recursive: true });
    const dir = fs.mkdtempSync(path.join(root, prefix));
    return {
        dir,
        cleanup: async (): Promise<void> => {
            await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
        },
    };
}

/**
 * Clone `source` (a git URL or local path) into a fresh disposable dir under `root`
 * and optionally check out `ref`. The no-auth primitive used for public repos and
 * exercised in tests; private-repo PRs go through {@link checkoutPr}, which uses gh.
 */
export async function createDisposableCheckout(opts: {
    source: string;
    ref?: string;
    root: string;
    depth?: number;
}): Promise<PrCheckout> {
    const { dir, cleanup } = makeDir(opts.root, "co-");
    try {
        const cloneArgs = ["clone", "--no-tags"];
        if (opts.depth) {
            cloneArgs.push("--depth", String(opts.depth));
        }
        cloneArgs.push(opts.source, dir);
        await run("git", cloneArgs, { maxBuffer: MAX_BUFFER });
        if (opts.ref) {
            await run("git", ["checkout", opts.ref], { cwd: dir, maxBuffer: MAX_BUFFER });
        }
        return { dir, cleanup };
    } catch (error) {
        await cleanup();
        throw error;
    }
}

/**
 * Materialize a PR's head into a fresh, disposable working tree using the GitHub CLI,
 * so private-repo and fork PRs both clone with an authenticated remote. The caller
 * MUST call {@link PrCheckout.cleanup} when the run finishes. A shallow clone keeps
 * this cheap; `gh pr checkout` fetches the PR ref (including from forks) on top.
 */
export async function checkoutPr(repo: string, prNumber: number, root: string): Promise<PrCheckout> {
    const { dir, cleanup } = makeDir(root, `pr-${prNumber}-`);
    try {
        logger.info(`Checking out ${repo}#${prNumber} into an isolated worktree`);
        await run("gh", ["repo", "clone", repo, dir, "--", "--no-tags", "--depth", "1"], { maxBuffer: MAX_BUFFER });
        // --detach: check out the PR head in detached HEAD, never a tracking branch. Bring-up
        // is read-only and never pushes, and this is the only form that works for a merged PR
        // whose head branch was deleted (plain `gh pr checkout` fails setting up tracking).
        await run("gh", ["pr", "checkout", String(prNumber), "-R", repo, "--detach"], {
            cwd: dir,
            maxBuffer: MAX_BUFFER,
        });
        return { dir, cleanup };
    } catch (error) {
        await cleanup();
        const text = error instanceof Error ? error.message : String(error);
        if (/auth|gh auth login|not logged/i.test(text)) {
            throw new Error("GitHub CLI is not authenticated — run `gh auth login`.");
        }
        throw new Error(`Could not check out ${repo}#${prNumber}: ${text}`);
    }
}
