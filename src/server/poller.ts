import { getPrMeta, type IssueComment, listIssueComments, logger, resolveWebPreviewUrl } from "../index";
import { bodyHasMarker, formatErrorComment, postVerdict } from "./comment";
import { loadServerConfig } from "./config";
import { isPrRunning, runProject } from "./runner";
import { singleton } from "./singleton";
import { listProjects, loadLedger, saveLedger } from "./store";
import type { HandledMention, MentionLedger, ProjectRecord, ServerConfig } from "./types";

function msg(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Match the mention handle as a token (so "@sentinel" doesn't match "@sentinelbot"). */
function mentionMatcher(handle: string): RegExp {
    return new RegExp(`${escapeRegExp(handle)}(?![\\w-])`, "i");
}

/** Whether a handled mention still needs to be re-polled in future ticks. */
type MentionOutcome = "unfinished" | "terminal";

/** Poller lifecycle — one instance across instrumentation + routes (see singleton). */
const state = singleton("poller.state", () => ({
    timer: null as ReturnType<typeof setTimeout> | null,
    running: false,
}));
/** Per-project backoff after consecutive failures. */
const backoff = singleton("poller.backoff", () => new Map<string, { failures: number; nextAt: number }>());

export function isPollerRunning(): boolean {
    return state.running;
}

export function startPoller(): void {
    if (state.running) {
        return;
    }
    state.running = true;
    const config = loadServerConfig();
    const tick = async (): Promise<void> => {
        try {
            await pollAll(config);
        } catch (error) {
            logger.warn(`Poller tick error: ${msg(error)}`);
        }
        if (state.running) {
            state.timer = setTimeout(tick, config.pollMs);
        }
    };
    logger.info(`Poller started (every ${Math.round(config.pollMs / 1000)}s).`);
    state.timer = setTimeout(tick, 1500);
}

export function stopPoller(): void {
    state.running = false;
    if (state.timer) {
        clearTimeout(state.timer);
        state.timer = null;
    }
}

async function pollAll(config: ServerConfig): Promise<void> {
    const projects = await listProjects();
    const now = Date.now();
    for (const project of projects) {
        const entry = backoff.get(project.id);
        if (entry && now < entry.nextAt) {
            continue;
        }
        try {
            await pollProject(project, config);
            backoff.delete(project.id);
        } catch (error) {
            const failures = (backoff.get(project.id)?.failures ?? 0) + 1;
            const delay = Math.min(config.pollMs * 2 ** failures, 5 * 60 * 1000);
            backoff.set(project.id, { failures, nextAt: Date.now() + delay });
            logger.warn(`Project ${project.id} poll failed (backoff ${Math.round(delay / 1000)}s): ${msg(error)}`);
        }
    }
}

async function pollProject(project: ProjectRecord, config: ServerConfig): Promise<void> {
    const ledger = await loadLedger(project.id);
    if (!ledger.repo) {
        ledger.repo = project.repo;
    }
    // First time we watch a repo: start from now rather than back-scanning its entire
    // comment history (which can be huge). Mentions are expected after the watch begins.
    if (!ledger.lastPolledAt) {
        ledger.lastPolledAt = new Date().toISOString();
        await saveLedger(project.id, ledger);
        return;
    }
    const comments = await listIssueComments(project.repo, { since: ledger.lastPolledAt });
    const mentionRe = mentionMatcher(project.mentionHandle);

    const candidates = comments.filter((c) => {
        if (!mentionRe.test(c.body)) {
            return false;
        }
        if (bodyHasMarker(c.body)) {
            return false; // Sentinel's own comment — never reply to self
        }
        const existing = ledger.handled[String(c.id)];
        // Only "pending" (preview not ready / transient) is re-pollable; claimed/done/errored are terminal.
        return !existing || existing.state === "pending";
    });

    // Timestamps of mentions that still need future polling — the watermark must not skip past them.
    const unfinished: string[] = [];
    let batchOk = true;
    for (const comment of candidates) {
        try {
            if ((await handleMention(project, comment, ledger, config)) === "unfinished") {
                unfinished.push(comment.createdAt);
            }
        } catch (error) {
            batchOk = false;
            logger.warn(`Mention ${comment.id} on ${project.repo} failed: ${msg(error)}`);
            break;
        }
    }

    if (batchOk) {
        if (unfinished.length > 0) {
            // Keep re-scanning from the oldest still-unfinished mention (since is inclusive).
            ledger.lastPolledAt = unfinished.reduce((a, b) => (a < b ? a : b));
        } else {
            let newest = ledger.lastPolledAt;
            for (const c of comments) {
                if (!newest || c.createdAt > newest) {
                    newest = c.createdAt;
                }
            }
            ledger.lastPolledAt = newest;
        }
        await saveLedger(project.id, ledger);
    }
}

function setHandled(ledger: MentionLedger, mention: HandledMention): void {
    ledger.handled[String(mention.commentId)] = mention;
}

async function handleMention(
    project: ProjectRecord,
    comment: IssueComment,
    ledger: MentionLedger,
    config: ServerConfig,
): Promise<MentionOutcome> {
    // Don't start a second run for a PR already in flight (manual trigger or another mention).
    if (isPrRunning(project.repo, comment.prNumber)) {
        return "unfinished";
    }

    const prior = ledger.handled[String(comment.id)];
    const retries = prior?.retries ?? 0;
    const at = new Date().toISOString();

    // Resolve the PR + preview. A non-PR mention or transient gh failure is a bounded retry,
    // not an infinite loop; a not-ready preview is the common, expected race.
    let headSha: string;
    try {
        headSha = (await getPrMeta(comment.prNumber, project.repo)).headSha;
    } catch (error) {
        const nextRetries = retries + 1;
        if (nextRetries >= config.maxPreviewRetries) {
            setHandled(ledger, {
                commentId: comment.id,
                pr: comment.prNumber,
                state: "errored",
                runId: null,
                retries: nextRetries,
                at,
            });
            await saveLedger(project.id, ledger);
            logger.warn(`Giving up on comment ${comment.id} (${project.repo}#${comment.prNumber}): ${msg(error)}`);
            return "terminal";
        }
        setHandled(ledger, {
            commentId: comment.id,
            pr: comment.prNumber,
            state: "pending",
            runId: null,
            retries: nextRetries,
            at,
        });
        await saveLedger(project.id, ledger);
        return "unfinished";
    }

    const targetUrl = await resolveWebPreviewUrl(project.repo, headSha, project.previewEnvIncludes);
    if (!targetUrl) {
        const nextRetries = retries + 1;
        if (nextRetries >= config.maxPreviewRetries) {
            setHandled(ledger, {
                commentId: comment.id,
                pr: comment.prNumber,
                state: "errored",
                runId: null,
                retries: nextRetries,
                at,
            });
            await saveLedger(project.id, ledger);
            await postVerdict(
                project.repo,
                comment.prNumber,
                formatErrorComment(
                    `I couldn't find a ready preview deployment for this PR after ${nextRetries} checks, so I can't record a run yet.`,
                    { runId: `${project.id}__${comment.prNumber}-pending` },
                ),
            );
            return "terminal";
        }
        setHandled(ledger, {
            commentId: comment.id,
            pr: comment.prNumber,
            state: "pending",
            runId: null,
            retries: nextRetries,
            at,
        });
        await saveLedger(project.id, ledger);
        logger.info(
            `PR #${comment.prNumber} on ${project.repo}: preview not ready (retry ${nextRetries}/${config.maxPreviewRetries}).`,
        );
        return "unfinished";
    }

    // Claim and FLUSH before running: a crash before "done" leaves this as claimed
    // (interrupted) and is never auto-rerun — avoiding any double-post.
    setHandled(ledger, { commentId: comment.id, pr: comment.prNumber, state: "claimed", runId: null, retries, at });
    await saveLedger(project.id, ledger);

    const { runId, status } = await runProject(project, comment.prNumber, comment.id, { targetUrl });
    setHandled(ledger, {
        commentId: comment.id,
        pr: comment.prNumber,
        state: status === "errored" ? "errored" : "done",
        runId,
        retries,
        at: new Date().toISOString(),
    });
    await saveLedger(project.id, ledger);
    return "terminal";
}
