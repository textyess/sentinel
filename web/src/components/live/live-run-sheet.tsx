import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CoverageCallout, VerdictCallout } from "@/components/live/verdict-callout";
import { PhaseStepper } from "@/components/live/phase-stepper";
import { RunLog } from "@/components/live/run-log";
import { StatusBadge } from "@/components/status-badge";
import {
    Sheet,
    SheetContent,
    SheetDescription,
    SheetHeader,
    SheetTitle,
} from "@/components/ui/sheet";
import { useLiveRun } from "@/hooks/use-live-run";
import { keys } from "@/hooks/queries";
import { activePhaseIndex, phasesFor } from "@/lib/phases";
import type { RunKind } from "@/lib/types";
import { cn } from "@/lib/utils";

export interface ActiveRun {
    runId: string;
    label: string;
    kind: RunKind;
}

function HeaderStatus({
    streaming,
    error,
    outcome,
}: {
    streaming: boolean;
    error: string | null;
    outcome: "pass" | "fail" | "uncertain" | "complete" | null;
}) {
    if (error) {
        return <StatusBadge status="errored" label="errored" />;
    }
    if (outcome === "complete") {
        return <StatusBadge status="passed" label="complete" />;
    }
    if (outcome) {
        return (
            <StatusBadge
                status={outcome === "pass" ? "passed" : outcome === "fail" ? "failed" : "uncertain"}
                label={outcome}
            />
        );
    }
    if (streaming) {
        return (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-running/30 bg-running/10 px-2.5 py-0.5 text-xs font-medium text-running">
                <span className="size-1.5 animate-pulse rounded-full bg-running" />
                Live
            </span>
        );
    }
    return null;
}

export function LiveRunSheet({
    activeRun,
    onOpenChange,
}: {
    activeRun: ActiveRun | null;
    onOpenChange: (open: boolean) => void;
}) {
    const qc = useQueryClient();
    const state = useLiveRun(activeRun?.runId ?? null);

    const terminal = Boolean(state.done) || Boolean(state.error);
    // Refresh the gallery + readiness badges once the run settles.
    useEffect(() => {
        if (terminal) {
            qc.invalidateQueries({ queryKey: keys.runs });
            qc.invalidateQueries({ queryKey: keys.projects });
        }
    }, [terminal, qc]);

    const kind = activeRun?.kind ?? "verify";
    const phases = phasesFor(kind);
    const activeIndex = activePhaseIndex(phases, state.lines);
    const done = state.done;

    const headerOutcome =
        done && "verdict" in done ? done.verdict.outcome : done ? "complete" : null;

    return (
        <Sheet open={Boolean(activeRun)} onOpenChange={onOpenChange}>
            <SheetContent side="right" className="w-full gap-0 sm:max-w-xl">
                {activeRun && (
                    <>
                        <SheetHeader className="gap-2 border-b">
                            <div className="flex items-center gap-2">
                                <span
                                    className={cn(
                                        "rounded-md border px-2 py-0.5 text-[11px] font-medium",
                                        kind === "crawl"
                                            ? "border-border text-muted-foreground"
                                            : "border-primary/30 bg-primary/10 text-primary",
                                    )}
                                >
                                    {kind === "crawl" ? "Baseline crawl" : "PR verify"}
                                </span>
                                <HeaderStatus streaming={state.streaming} error={state.error} outcome={headerOutcome} />
                            </div>
                            <SheetTitle className="truncate">{activeRun.label}</SheetTitle>
                            <SheetDescription className="sr-only">Live progress for this run</SheetDescription>
                        </SheetHeader>

                        <div className="flex min-h-0 flex-1 flex-col gap-4 p-6">
                            <PhaseStepper phases={phases} activeIndex={activeIndex} done={Boolean(done)} />

                            {state.error && (
                                <div className="rounded-xl border border-fail/30 bg-fail/5 p-4 text-sm text-fail">
                                    {state.error}
                                </div>
                            )}
                            {done && "verdict" in done && (
                                <VerdictCallout verdict={done.verdict} videoUrl={done.videoUrl} />
                            )}
                            {done && "coverage" in done && <CoverageCallout coverage={done.coverage} />}

                            <div className="min-h-0 flex-1">
                                <RunLog lines={state.lines} streaming={state.streaming} />
                            </div>
                        </div>
                    </>
                )}
            </SheetContent>
        </Sheet>
    );
}
