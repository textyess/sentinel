import { outcomeStatus, StatusBadge } from "@/components/status-badge";
import type { CrawlCoverage, Verdict } from "@/lib/types";
import { cn } from "@/lib/utils";

const ACCENT: Record<string, string> = {
    pass: "border-pass/30 bg-pass/5",
    fail: "border-fail/30 bg-fail/5",
    uncertain: "border-uncertain/30 bg-uncertain/5",
};

export function VerdictCallout({ verdict, videoUrl }: { verdict: Verdict; videoUrl: string | null }) {
    return (
        <div className={cn("grid gap-3 rounded-xl border p-4", ACCENT[verdict.outcome] ?? "border-border")}>
            <div className="flex items-center gap-2">
                <StatusBadge status={outcomeStatus(verdict.outcome)} />
                <span className="text-xs text-muted-foreground">{verdict.confidence} confidence</span>
            </div>
            <p className="text-sm leading-relaxed text-foreground/90">{verdict.summary}</p>
            {verdict.evidence.length > 0 && (
                <ul className="grid gap-1.5 border-t pt-3">
                    {verdict.evidence.map((item, i) => (
                        <li key={i} className="flex gap-2 text-xs text-muted-foreground">
                            <span className="text-muted-foreground/50">—</span>
                            <span>{item}</span>
                        </li>
                    ))}
                </ul>
            )}
            {videoUrl && (
                <video
                    controls
                    preload="metadata"
                    src={videoUrl}
                    aria-label="Run recording"
                    className="mt-1 aspect-video w-full rounded-lg bg-black"
                />
            )}
        </div>
    );
}

export function CoverageCallout({ coverage }: { coverage: CrawlCoverage }) {
    const stats = [
        { label: "Page states", value: coverage.nodeCount },
        { label: "Nav edges", value: coverage.edgeCount },
        { label: "Routes reached", value: coverage.routesReached },
        { label: "Unreached", value: coverage.routesUnreached },
    ];
    return (
        <div className="grid gap-3 rounded-xl border border-pass/30 bg-pass/5 p-4">
            <StatusBadge status="passed" label="Baseline ready" />
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {stats.map((s) => (
                    <div key={s.label} className="grid gap-0.5">
                        <span className="font-mono text-lg tabular-nums">{s.value}</span>
                        <span className="text-xs text-muted-foreground">{s.label}</span>
                    </div>
                ))}
            </div>
        </div>
    );
}
