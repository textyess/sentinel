import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { REPO_ROOT } from "../config";

const run = promisify(execFile);

/** Run a gh command from the repo root (so it auto-detects the repo), returning stdout. */
async function gh(args: string[]): Promise<string> {
    const { stdout } = await run("gh", args, { cwd: REPO_ROOT, maxBuffer: 16 * 1024 * 1024 });
    return stdout;
}

export interface PrMeta {
    number: number;
    title: string;
    body: string;
    headSha: string;
    headRef: string;
}

export async function detectRepo(): Promise<string | null> {
    try {
        return (await gh(["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"])).trim() || null;
    } catch {
        return null;
    }
}

/** Translate a raw gh failure into an actionable message. */
function ghError(error: unknown, prNumber: number): Error {
    const text = error instanceof Error ? error.message : String(error);
    if (/auth|gh auth login|not logged/i.test(text)) {
        return new Error("GitHub CLI is not authenticated — run `gh auth login`.");
    }
    if (/no pull requests|could not resolve|not found/i.test(text)) {
        return new Error(`PR #${prNumber} not found (or no access). Check the number and repo.`);
    }
    return new Error(`gh failed for PR #${prNumber}: ${text}`);
}

export async function getPrMeta(prNumber: number): Promise<PrMeta> {
    let out: string;
    try {
        out = await gh(["pr", "view", String(prNumber), "--json", "number,title,body,headRefOid,headRefName"]);
    } catch (error) {
        throw ghError(error, prNumber);
    }
    if (!out.trim()) {
        throw new Error(`Empty response from gh for PR #${prNumber}.`);
    }
    const parsed = JSON.parse(out) as {
        number: number;
        title?: string;
        body?: string;
        headRefOid: string;
        headRefName: string;
    };
    return {
        number: parsed.number,
        title: parsed.title ?? "",
        body: parsed.body ?? "",
        headSha: parsed.headRefOid,
        headRef: parsed.headRefName,
    };
}

/** The PR's unified diff, truncated — supplementary signal for the planner. */
export async function getPrDiff(prNumber: number, maxChars: number): Promise<string> {
    try {
        const out = await gh(["pr", "diff", String(prNumber)]);
        return out.length > maxChars ? `${out.slice(0, maxChars)}\n... (diff truncated)` : out;
    } catch {
        return "";
    }
}

export async function getChangedFiles(prNumber: number): Promise<string[]> {
    let out: string;
    try {
        out = await gh(["pr", "diff", String(prNumber), "--name-only"]);
    } catch (error) {
        throw ghError(error, prNumber);
    }
    return out
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
}

/**
 * Resolve the URL of the PR's web preview deployment from the GitHub deployments
 * API: find the "Preview – <web>" deployment for the head sha and read its
 * environment_url (the *.vercel.app URL). Returns null if there is no ready preview.
 */
export async function resolveWebPreviewUrl(repo: string, headSha: string, envIncludes: string): Promise<string | null> {
    try {
        const deploysOut = await gh(["api", `repos/${repo}/deployments?sha=${headSha}&per_page=30`]);
        const deploys = JSON.parse(deploysOut) as Array<{ id: number; environment: string }>;
        const needle = envIncludes.toLowerCase();
        // Want the *preview* web deployment — contains "web", is a preview (not production),
        // and isn't the admin/partners app.
        const web = deploys.find((d) => {
            const env = d.environment.toLowerCase();
            return env.includes(needle) && env.includes("preview") && !/admin|partner/.test(env);
        });
        if (!web) {
            return null;
        }
        const statusesOut = await gh(["api", `repos/${repo}/deployments/${web.id}/statuses?per_page=30`]);
        const statuses = JSON.parse(statusesOut) as Array<{ state: string; environment_url?: string }>;
        // Only a SUCCESSFUL deployment — never replay against an errored / in-progress / inactive preview.
        const ready = statuses.find((s) => s.state === "success" && s.environment_url);
        return ready?.environment_url ?? null;
    } catch {
        return null;
    }
}
