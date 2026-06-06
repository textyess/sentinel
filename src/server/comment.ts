import type { VerifyManifest } from "../index";
import { postPrComment, redactSecret, SENTINEL } from "../index";

/**
 * Sentinel posts under the operator's own gh identity, so every comment carries a
 * hidden marker the poller uses to skip its own messages (no reply-to-self loop).
 */
const MARKER_PREFIX = "<!-- sentinel:run=";

export function runMarker(runId: string): string {
    return `${MARKER_PREFIX}${runId} -->`;
}

export function bodyHasMarker(body: string): boolean {
    return body.includes(MARKER_PREFIX);
}

export interface CommentContext {
    runId: string;
    /** Absolute URL of the run's report page — verdict, plan, step-by-step results, and recording. */
    reportUrl: string;
}

/**
 * The verdict comment is intentionally JUST a link to the run's report page: the
 * verdict, the plan, the step-by-step results, and the recording all live there, so
 * the PR thread stays a single clickable line instead of a wall of text. The trailing
 * marker is an invisible HTML comment the poller uses to skip Sentinel's own comments
 * (no reply-to-self loop) — it renders as nothing.
 */
export function formatVerdictComment(m: VerifyManifest, ctx: CommentContext): string {
    return [`${SENTINEL.glyph} [Sentinel report for PR #${m.pr} →](${ctx.reportUrl})`, "", runMarker(ctx.runId)].join(
        "\n",
    );
}

export function formatErrorComment(reason: string, ctx: { runId: string }): string {
    return [`${SENTINEL.glyph} **${SENTINEL.name}**`, "", reason, "", runMarker(ctx.runId)].join("\n");
}

/** Redact the entire body at this single chokepoint, then post. */
export async function postVerdict(repo: string, pr: number, body: string): Promise<void> {
    await postPrComment(repo, pr, redactSecret(body));
}
