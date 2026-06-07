import type { EnvConfig } from "../config";
import { runCrawlForProject } from "../crawler/run";
import { loadGraph } from "../graph/store";
import type { CoverageReport } from "../graph/types";
import type { Reasoner } from "../reasoner/types";
import type { RepoAdapter } from "../types";
import { generateSkillPack } from "./generate";
import type { SkillPack } from "./types";

/**
 * The bits of a verify run's `skill-proposals.json` that promotion needs. Kept
 * structural so this module does not couple to the verify path — it consumes a drift
 * signal as a gate and a report aid, and NEVER copies its contents into a skill.
 */
export interface DriftSignal {
    /** The URL the drift was observed against — a PR preview. Used only to gate + report. */
    targetUrl: string;
    proposals: { route: string }[];
}

/**
 * Safety gate: promotion re-derives skills from a fresh BASELINE crawl, never from a PR
 * preview. Refuse when the drift signal was recorded against the very URL we are about
 * to crawl (i.e. the crawl target is a preview), so preview behaviour can never become a
 * canonical skill. Returns a refusal reason, or null when it is safe to proceed.
 */
export function previewSourceRefusal(signal: { targetUrl: string } | null, baseUrl: string): string | null {
    if (!signal) {
        return null;
    }
    // Compare origin + path so a host-case or default-port variant of the crawl target
    // can't slip a preview-sourced signal past the gate (origin lowercases host, drops :443).
    const norm = (url: string): string => {
        try {
            const parsed = new URL(url.trim());
            return `${parsed.origin.toLowerCase()}${parsed.pathname.replace(/\/+$/, "")}`;
        } catch {
            return url.trim().toLowerCase().replace(/\/+$/, "");
        }
    };
    if (norm(signal.targetUrl) === norm(baseUrl)) {
        return `Refusing to promote: the drift signal was recorded against ${signal.targetUrl}, which is the crawl target. Promotion must re-derive skills from the baseline, never from the preview the drift was seen on.`;
    }
    return null;
}

export interface ReconcileArgs {
    /** Adapter scoped to the BASELINE url (same as a crawl), NEVER a preview. */
    adapter: RepoAdapter;
    env: EnvConfig;
    outputDir: string;
    maxPages: number;
    actuationsPerPage: number;
    reasoner: Reasoner;
    gitSha: string | null;
    /** Optional drift signal from a verify run — a gate + reporting aid, never copied into skills/. */
    drift: DriftSignal | null;
}

export interface ReconcileResult {
    graphFile: string;
    pack: SkillPack;
    coverage: CoverageReport;
    /** Routes the drift signal flagged (for the report); empty when no signal was given. */
    driftedRoutes: string[];
}

/**
 * The only non-`generateSkillPack` path that rewrites skills/, and it still does so by
 * RE-DERIVING from a fresh, read-only BASELINE crawl — never by copying a preview's
 * behaviour. The {@link previewSourceRefusal} gate ensures the drift signal did not come
 * from the crawl target, so a PR preview can never become a canonical skill. The crawl is
 * always read-only ({@link runCrawlForProject} has no write path). Human / post-merge
 * gated by the caller.
 */
export async function reconcileSkillPack(args: ReconcileArgs): Promise<ReconcileResult> {
    const refusal = previewSourceRefusal(args.drift, args.adapter.baseUrl);
    if (refusal) {
        throw new Error(refusal);
    }
    const crawl = await runCrawlForProject({
        adapter: args.adapter,
        env: args.env,
        outputDir: args.outputDir,
        maxPages: args.maxPages,
        actuationsPerPage: args.actuationsPerPage,
        reasoner: args.reasoner,
        gitSha: args.gitSha,
    });
    const graph = loadGraph(crawl.graphFile);
    const pack = await generateSkillPack({
        graph,
        outputDir: args.outputDir,
        adapterId: args.adapter.id,
        reasoner: args.reasoner,
    });
    const driftedRoutes = args.drift ? Array.from(new Set(args.drift.proposals.map((p) => p.route))).sort() : [];
    return { graphFile: crawl.graphFile, pack, coverage: crawl.coverage, driftedRoutes };
}
