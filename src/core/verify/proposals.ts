import type { DiscrepancyKind, SkillDiscrepancy } from "./types";

/**
 * The inert skill-proposal artifact a verify run may emit when the baseline navigation
 * skill diverged from the preview. It is the same redacted, disposable family as
 * `manifest.json` — written to the run directory, NEVER to `skills/`. Promotion into a
 * real skill happens out of band (`skills reconcile`/`promote`), re-derived from a fresh
 * baseline crawl, never copied from a preview. `status` is always "proposed".
 */
export interface SkillProposal {
    kind: DiscrepancyKind;
    route: string;
    skillSlug: string;
    detail: string;
}

export interface SkillProposalsFile {
    pr: number;
    headSha: string;
    /** Repo sha the baseline graph/skills were crawled from — the pack a reconcile would refresh. */
    baselineGitSha: string | null;
    targetUrl: string;
    createdAt: string;
    status: "proposed";
    /** Count by kind, for a quick glance on the report. */
    summary: Record<DiscrepancyKind, number>;
    proposals: SkillProposal[];
}

export interface ProposalMeta {
    pr: number;
    headSha: string;
    baselineGitSha: string | null;
    targetUrl: string;
    /** Caller-supplied timestamp (workflow scripts can't call Date.now()). */
    createdAt: string;
}

/**
 * Build the inert proposals artifact from the run's discrepancies. Deduped by
 * kind+route+skillSlug+detail. Returns null when there were no discrepancies (so the
 * caller writes nothing). Pure — no IO, no `skills/` access.
 */
export function buildSkillProposals(discrepancies: SkillDiscrepancy[], meta: ProposalMeta): SkillProposalsFile | null {
    if (discrepancies.length === 0) {
        return null;
    }
    const seen = new Set<string>();
    const proposals: SkillProposal[] = [];
    const summary: Record<DiscrepancyKind, number> = {
        "selector-stale": 0,
        "missing-control": 0,
        "destination-drift": 0,
    };
    for (const d of discrepancies) {
        const key = JSON.stringify([d.kind, d.route, d.skillSlug, d.detail]);
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        proposals.push({ kind: d.kind, route: d.route, skillSlug: d.skillSlug, detail: d.detail });
        summary[d.kind] += 1;
    }
    return {
        pr: meta.pr,
        headSha: meta.headSha,
        baselineGitSha: meta.baselineGitSha,
        targetUrl: meta.targetUrl,
        createdAt: meta.createdAt,
        status: "proposed",
        summary,
        proposals,
    };
}

/**
 * A one-line-per-discrepancy note for the verdict prompt; empty string when there were
 * none. Framed so the judge weighs divergence-from-baseline against the PR claim rather
 * than treating it as a defect — the preview is the *changed* app, so a divergence is
 * often exactly the PR's intended change.
 */
export function discrepancyVerdictNote(discrepancies: SkillDiscrepancy[]): string {
    if (discrepancies.length === 0) {
        return "";
    }
    const lines = discrepancies.slice(0, 8).map((d) => `- [${d.kind}] ${d.route}: ${d.detail}`);
    const more = discrepancies.length > 8 ? `\n- …and ${discrepancies.length - 8} more` : "";
    return `The baseline navigation skill diverged from the preview on ${discrepancies.length} point(s). The preview is the CHANGED app, so a divergence is often exactly what this PR intends — weigh it against the PR claim, do not treat it as a defect on its own:\n${lines.join("\n")}${more}`;
}
