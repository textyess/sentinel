import { CheckIcon } from "lucide-react";
import type { Phase } from "@/lib/phases";
import { cn } from "@/lib/utils";

type StepState = "done" | "active" | "pending";

function Node({ state, index }: { state: StepState; index: number }) {
    return (
        <span
            className={cn(
                "z-10 grid size-6 shrink-0 place-items-center rounded-full border bg-card text-[11px] font-medium transition-colors",
                state === "done" && "border-pass/40 bg-pass/15 text-pass",
                state === "active" && "border-running bg-running/15 text-running pulse-ring",
                state === "pending" && "border-border text-muted-foreground",
            )}
        >
            {state === "done" ? <CheckIcon className="size-3.5" /> : index + 1}
        </span>
    );
}

export function PhaseStepper({
    phases,
    activeIndex,
    done,
}: {
    phases: Phase[];
    activeIndex: number;
    done: boolean;
}) {
    return (
        <ol className="flex items-start">
            {phases.map((phase, i) => {
                const state: StepState = done || i < activeIndex ? "done" : i === activeIndex ? "active" : "pending";
                const filledLeft = done || i <= activeIndex;
                const filledRight = done || i < activeIndex;
                return (
                    <li key={phase.key} className="flex min-w-0 flex-1 flex-col items-center gap-1.5">
                        <div className="flex w-full items-center">
                            <span className={cn("h-px flex-1", i === 0 ? "opacity-0" : filledLeft ? "bg-pass/40" : "bg-border")} />
                            <Node state={state} index={i} />
                            <span
                                className={cn(
                                    "h-px flex-1",
                                    i === phases.length - 1 ? "opacity-0" : filledRight ? "bg-pass/40" : "bg-border",
                                )}
                            />
                        </div>
                        <span
                            className={cn(
                                "truncate text-[11px] font-medium tracking-tight transition-colors",
                                state === "pending" ? "text-muted-foreground" : "text-foreground",
                            )}
                        >
                            {phase.label}
                        </span>
                    </li>
                );
            })}
        </ol>
    );
}
