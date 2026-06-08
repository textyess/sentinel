import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { REPO_ROOT } from "../config";

const run = promisify(execFile);

/** Run a gh command from the repo root (so it auto-detects the repo), returning stdout. */
async function gh(args: string[]): Promise<string> {
    const { stdout } = await run("gh", args, { cwd: REPO_ROOT, maxBuffer: 64 * 1024 * 1024 });
    return stdout;
}

/**
 * `-R <repo>` flag for `pr` subcommands when an explicit repo is supplied. When it
 * is omitted (CLI single-repo path) the empty array preserves the cwd:REPO_ROOT
 * auto-detection. Server code paths ALWAYS pass repo, so they never auto-detect.
 */
function repoFlag(repo: string | undefined): string[] {
    return repo ? ["-R", repo] : [];
}

export interface PrMeta {
    number: number;
    title: string;
    body: string;
    headSha: string;
    headRef: string;
}

export interface IssueComment {
    id: number;
    body: string;
    author: string;
    createdAt: string;
    prNumber: number;
}

export async function detectRepo(): Promise<string | null> {
    try {
        return (await gh(["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"])).trim() || null;
    } catch {
        return null;
    }
}

/** True when the GitHub CLI has an authenticated session (needed to poll + comment). */
export async function isGhAuthenticated(): Promise<boolean> {
    try {
        await run("gh", ["auth", "status"], { cwd: REPO_ROOT });
        return true;
    } catch {
        return false;
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

export async function getPrMeta(prNumber: number, repo?: string): Promise<PrMeta> {
    let out: string;
    try {
        out = await gh([
            "pr",
            "view",
            String(prNumber),
            ...repoFlag(repo),
            "--json",
            "number,title,body,headRefOid,headRefName",
        ]);
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
export async function getPrDiff(prNumber: number, maxChars: number, repo?: string): Promise<string> {
    try {
        const out = await gh(["pr", "diff", String(prNumber), ...repoFlag(repo)]);
        return out.length > maxChars ? `${out.slice(0, maxChars)}\n... (diff truncated)` : out;
    } catch {
        return "";
    }
}

export async function getChangedFiles(prNumber: number, repo?: string): Promise<string[]> {
    let out: string;
    try {
        out = await gh(["pr", "diff", String(prNumber), ...repoFlag(repo), "--name-only"]);
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
        // Want the *preview* web deployment — contains the needle, is a preview (not production),
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

/**
 * List a directory's entries in a repo via the contents API (no clone). Returns null
 * on any failure (e.g. a 404 for a missing dir), so callers can probe for existence.
 * `repo` is "owner/name"; `dirPath` "" reads the repo root.
 */
export async function listRepoDir(
    repo: string,
    dirPath: string,
): Promise<Array<{ name: string; type: "file" | "dir" }> | null> {
    if (!repo) {
        return null;
    }
    const suffix = dirPath ? `/${dirPath.replace(/^\/+|\/+$/g, "")}` : "";
    try {
        const out = await gh(["api", `repos/${repo}/contents${suffix}`]);
        const parsed = JSON.parse(out) as Array<{ name?: string; type?: string }>;
        if (!Array.isArray(parsed)) {
            return null;
        }
        return parsed
            .filter((e): e is { name: string; type: string } => typeof e.name === "string")
            .map((e) => ({ name: e.name, type: e.type === "dir" ? "dir" : "file" }));
    } catch {
        return null;
    }
}

/**
 * Read a single file's contents from a repo via the contents API (no clone). Returns null
 * on any failure (e.g. a 404 for a missing file), so callers can probe-and-fall-back. The
 * `raw` Accept header returns the bytes directly rather than base64-wrapped JSON.
 */
export async function readRepoFile(repo: string, filePath: string): Promise<string | null> {
    if (!repo) {
        return null;
    }
    const clean = filePath.replace(/^\/+/, "");
    try {
        return await gh(["api", `repos/${repo}/contents/${clean}`, "-H", "Accept: application/vnd.github.raw"]);
    } catch {
        return null;
    }
}

/**
 * Best-effort resolution of a repo's production (or baseline) web URL from its
 * deployments — the environment whose name includes `envIncludes` and is NOT a PR
 * preview. Returns null when none is found (the human supplies the URL instead).
 */
export async function resolveProductionUrl(repo: string, envIncludes: string): Promise<string | null> {
    if (!repo) {
        return null;
    }
    try {
        const out = await gh(["api", `repos/${repo}/deployments?per_page=30`]);
        const deploys = JSON.parse(out) as Array<{ id: number; environment: string }>;
        const needle = envIncludes.toLowerCase();
        const prod =
            deploys.find((d) => {
                const env = d.environment.toLowerCase();
                return env.includes(needle) && !env.includes("preview");
            }) ?? deploys.find((d) => !d.environment.toLowerCase().includes("preview"));
        if (!prod) {
            return null;
        }
        const statusesOut = await gh(["api", `repos/${repo}/deployments/${prod.id}/statuses?per_page=30`]);
        const statuses = JSON.parse(statusesOut) as Array<{ state: string; environment_url?: string }>;
        const ready = statuses.find((s) => s.state === "success" && s.environment_url);
        return ready?.environment_url ?? null;
    } catch {
        return null;
    }
}

/** Extract a PR number from an issue/comment's issue_url (".../issues/<n>"). */
function prNumberFromIssueUrl(issueUrl: string): number {
    const segment = issueUrl.split("/").pop() ?? "";
    return Number.parseInt(segment, 10);
}

/**
 * List a repo's PR/issue conversation comments, newest activity first, optionally
 * bounded by `since` (ISO timestamp) to avoid re-reading the whole history each
 * poll. `repo` is REQUIRED — the server must never fall back to cwd auto-detection.
 */
export async function listIssueComments(repo: string, opts: { since?: string }): Promise<IssueComment[]> {
    if (!repo) {
        throw new Error("listIssueComments requires an explicit repo (owner/name).");
    }
    const params = new URLSearchParams({ per_page: "100", sort: "created", direction: "asc" });
    if (opts.since) {
        params.set("since", opts.since);
    }
    // No --paginate: bounded to a single page. The poller advances `since` each tick,
    // so one page of 100 comfortably covers a poll interval and never fetches the
    // repo's entire comment history (which can exceed the subprocess stdout buffer).
    const out = await gh(["api", `repos/${repo}/issues/comments?${params.toString()}`]);
    const parsed = JSON.parse(out) as Array<{
        id: number;
        body?: string;
        user?: { login?: string };
        created_at: string;
        issue_url: string;
    }>;
    return parsed.map((c) => ({
        id: c.id,
        body: c.body ?? "",
        author: c.user?.login ?? "",
        createdAt: c.created_at,
        prNumber: prNumberFromIssueUrl(c.issue_url),
    }));
}

/**
 * Post a comment on a PR. `repo` is REQUIRED. The body is written to a temp file
 * and passed via `--body-file` so arbitrary content (markdown, newlines) survives
 * intact and never lands on the command line.
 */
export async function postPrComment(repo: string, prNumber: number, body: string): Promise<void> {
    if (!repo) {
        throw new Error("postPrComment requires an explicit repo (owner/name).");
    }
    const tmpFile = path.join(os.tmpdir(), `sentinel-comment-${randomUUID()}.md`);
    fs.writeFileSync(tmpFile, body);
    try {
        await gh(["pr", "comment", String(prNumber), "-R", repo, "--body-file", tmpFile]);
    } finally {
        fs.rmSync(tmpFile, { force: true });
    }
}

/**
 * Publish a file as a release asset under a dedicated tag, creating the holding
 * release on first use (idempotent — an existing tag is reused). Returns the asset's
 * browser download URL. The asset is NOT committed to git: release assets live in
 * GitHub's per-repo blob storage, so this never touches the source tree or history.
 * For private/internal repos the URL is auth-gated, so only users with repo access
 * (i.e. the PR's reviewers) can open it. `repo` is REQUIRED.
 *
 * gh derives the asset name from the file's basename, so the source is copied to a
 * temp file named `assetName` first; `--clobber` overwrites a same-named asset, so a
 * re-run of the same PR replaces its recording rather than erroring.
 */
export async function uploadReleaseAsset(
    repo: string,
    tag: string,
    filePath: string,
    assetName: string,
): Promise<string> {
    if (!repo) {
        throw new Error("uploadReleaseAsset requires an explicit repo (owner/name).");
    }
    try {
        await gh(["release", "view", tag, "-R", repo]);
    } catch {
        // First use: create the artifact bucket. --latest=false keeps it off the
        // repo's "Latest release" badge — it's a holding area, not a software release.
        await gh([
            "release",
            "create",
            tag,
            "-R",
            repo,
            "--title",
            "Sentinel QA artifacts",
            "--notes",
            "Run recordings uploaded automatically by Sentinel. Not a software release.",
            "--latest=false",
        ]);
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-asset-"));
    const uploadPath = path.join(tmpDir, assetName);
    try {
        fs.copyFileSync(filePath, uploadPath);
        await gh(["release", "upload", tag, uploadPath, "-R", repo, "--clobber"]);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    // Read the asset's URL back rather than constructing it, so any server-side name
    // normalization is reflected exactly.
    const out = await gh(["release", "view", tag, "-R", repo, "--json", "assets"]);
    const parsed = JSON.parse(out) as { assets?: Array<{ name: string; url: string }> };
    const asset = (parsed.assets ?? []).find((a) => a.name === assetName);
    if (!asset) {
        throw new Error(`Uploaded asset ${assetName} not found in release ${tag}.`);
    }
    return asset.url;
}
