import {
    BanIcon,
    CheckCircle2Icon,
    CircleHelpIcon,
    ClockIcon,
    Loader2Icon,
    TriangleAlertIcon,
    XCircleIcon,
} from "lucide-react";
import type { ComponentType } from "react";
import { cn } from "@/lib/utils";
import type { Outcome, RunStatus } from "@/lib/types";

type Visual = {
    label: string;
    icon: ComponentType<{ className?: string }>;
    /** text / border / tinted-bg utility classes keyed off the status tokens. */
    className: string;
    spin?: boolean;
};

const STATUS: Record<RunStatus, Visual> = {
    passed: { label: "Passed", icon: CheckCircle2Icon, className: "text-pass border-pass/30 bg-pass/12" },
    failed: { label: "Failed", icon: XCircleIcon, className: "text-fail border-fail/30 bg-fail/12" },
    uncertain: {
        label: "Uncertain",
        icon: CircleHelpIcon,
        className: "text-uncertain border-uncertain/30 bg-uncertain/12",
    },
    running: { label: "Running", icon: Loader2Icon, className: "text-running border-running/30 bg-running/12", spin: true },
    queued: { label: "Queued", icon: ClockIcon, className: "text-running border-running/30 bg-running/12" },
    blocked: { label: "Blocked", icon: BanIcon, className: "text-blocked border-blocked/30 bg-blocked/12" },
    errored: { label: "Errored", icon: TriangleAlertIcon, className: "text-fail border-fail/30 bg-fail/12" },
};

const OUTCOME_TO_STATUS: Record<Outcome, RunStatus> = {
    pass: "passed",
    fail: "failed",
    uncertain: "uncertain",
};

export function StatusBadge({
    status,
    label,
    className,
}: {
    status: RunStatus;
    /** Override the default label (e.g. show the raw outcome verb). */
    label?: string;
    className?: string;
}) {
    const v = STATUS[status];
    const Icon = v.icon;
    return (
        <span
            className={cn(
                "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium tracking-tight",
                v.className,
                className,
            )}
        >
            <Icon className={cn("size-3.5", v.spin && "animate-spin")} />
            {label ?? v.label}
        </span>
    );
}

export function outcomeStatus(outcome: Outcome): RunStatus {
    return OUTCOME_TO_STATUS[outcome];
}
