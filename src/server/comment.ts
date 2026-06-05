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
    /** /api/runs/:runId/video, or null when no recording was produced. */
    videoUrl: string | null;
    /** e.g. http://127.0.0.1:4317 */
    dashboardUrl: string;
    /**
     * GitHub-hosted URL of the recording when it was published (a release asset), or
     * null when publishing is off or failed. Reviewers with repo access can open it.
     */
    publishedVideoUrl?: string | null;
}

/**
 * The "Recording" block. When the recording was published to GitHub, lead with a
 * link reviewers can actually open; otherwise fall back to the local-only dashboard
 * note (the video lives on the operator's machine and nobody else can reach it).
 */
function recordingLines(ctx: CommentContext): string[] {
    if (ctx.publishedVideoUrl) {
        const lines = [
            "**Recording**",
            `▶ [Watch the recording](${ctx.publishedVideoUrl}) — the full read-only walk of the affected routes.`,
        ];
        if (ctx.videoUrl) {
            lines.push(`_Operator copy: ${ctx.dashboardUrl}${ctx.videoUrl} (local-only)._`);
        }
        return lines;
    }
    if (ctx.videoUrl) {
        return [
            "**Recording**",
            "Saved locally on the operator's machine — view it in the Sentinel dashboard:",
            `${ctx.dashboardUrl}${ctx.videoUrl}  _(local-only)_`,
        ];
    }
    return ["**Recording**", "No screen recording was produced for this run."];
}

/**
 * Build the verdict comment from STRUCTURED manifest fields only — the raw PR body
 * is never echoed back. The video lives on the operator's machine, so the comment
 * links to the local dashboard URL and says so plainly.
 */
export function formatVerdictComment(m: VerifyManifest, ctx: CommentContext): string {
    const routes = m.affectedRoutes.length > 0 ? m.affectedRoutes.join(", ") : "the affected area";
    const evidence =
        m.verdict.evidence.length > 0
            ? m.verdict.evidence.map((e) => `- ${e}`).join("\n")
            : "- (no specific evidence captured)";
    const recording = recordingLines(ctx);

    return [
        `${SENTINEL.glyph} **${SENTINEL.name}** — verified PR #${m.pr} against the preview deployment`,
        "",
        `**Outcome: ${m.verdict.outcome.toUpperCase()}** (confidence: ${m.verdict.confidence})`,
        "",
        m.verdict.summary,
        "",
        "**What I checked**",
        `- ${m.plan.goal}`,
        `- Walked ${routes} — read-only; every mutating request was aborted (${m.blockedWrites} blocked).`,
        "",
        "**Evidence**",
        evidence,
        "",
        ...recording,
        "",
        `_Run ${m.createdAt} · model ${m.model}_`,
        "",
        runMarker(ctx.runId),
    ].join("\n");
}

export function formatErrorComment(reason: string, ctx: { runId: string }): string {
    return [`${SENTINEL.glyph} **${SENTINEL.name}**`, "", reason, "", runMarker(ctx.runId)].join("\n");
}

/** Redact the entire body at this single chokepoint, then post. */
export async function postVerdict(repo: string, pr: number, body: string): Promise<void> {
    await postPrComment(repo, pr, redactSecret(body));
}
