import {
    ArrowRightIcon,
    BanIcon,
    CheckIcon,
    ChevronDownIcon,
    EyeIcon,
    HourglassIcon,
    KeyboardIcon,
    type LucideIcon,
    MousePointer2Icon,
    MousePointerClickIcon,
    MoveVerticalIcon,
    XIcon,
} from "lucide-react";
import type { StepAction, StepResultView, StepStatus, TestPlan } from "@/lib/types";
import { cn } from "@/lib/utils";

const ACTION: Record<StepAction, { label: string; icon: LucideIcon }> = {
    navigate: { label: "Navigate", icon: ArrowRightIcon },
    click: { label: "Click", icon: MousePointerClickIcon },
    type: { label: "Type", icon: KeyboardIcon },
    select: { label: "Select", icon: ChevronDownIcon },
    hover: { label: "Hover", icon: MousePointer2Icon },
    scroll: { label: "Scroll", icon: MoveVerticalIcon },
    assert: { label: "Assert", icon: EyeIcon },
    wait: { label: "Wait", icon: HourglassIcon },
};

type NodeState = StepStatus | "pending";

const STATUS: Record<NodeState, { label: string; node: string; pill: string; icon: LucideIcon | null }> = {
    ok: {
        label: "OK",
        node: "border-pass/40 bg-pass/15 text-pass",
        pill: "border-pass/30 bg-pass/12 text-pass",
        icon: CheckIcon,
    },
    failed: {
        label: "Failed",
        node: "border-fail/40 bg-fail/15 text-fail",
        pill: "border-fail/30 bg-fail/12 text-fail",
        icon: XIcon,
    },
    blocked: {
        label: "Blocked (read-only)",
        node: "border-blocked/40 bg-blocked/15 text-blocked",
        pill: "border-blocked/30 bg-blocked/12 text-blocked",
        icon: BanIcon,
    },
    skipped: {
        label: "Skipped",
        node: "border-border text-muted-foreground",
        pill: "border-border text-muted-foreground",
        icon: null,
    },
    pending: {
        label: "Not run",
        node: "border-border text-muted-foreground",
        pill: "border-border text-muted-foreground",
        icon: null,
    },
};

function StatusNode({ state, index }: { state: NodeState; index: number }) {
    const v = STATUS[state];
    const Icon = v.icon;
    return (
        <span
            className={cn(
                "z-10 grid size-7 shrink-0 place-items-center rounded-full border bg-card text-xs font-medium tabular-nums",
                v.node,
            )}>
            {Icon ? <Icon className="size-3.5" /> : index + 1}
        </span>
    );
}

function Detail({ label, value, tone }: { label: string; value: string; tone?: string }) {
    return (
        <div className="grid grid-cols-[5rem_1fr] gap-x-3 gap-y-0.5 text-sm sm:grid-cols-[6rem_1fr]">
            <dt className="pt-px text-xs font-medium text-muted-foreground">{label}</dt>
            <dd className={cn("leading-relaxed text-foreground/90", tone)}>{value}</dd>
        </div>
    );
}

function ErrorList({ title, items }: { title: string; items: string[] }) {
    if (items.length === 0) {
        return null;
    }
    return (
        <div className="rounded-lg border border-fail/25 bg-fail/5 p-2.5">
            <p className="mb-1 text-xs font-medium text-fail">{title}</p>
            <ul className="grid gap-1">
                {items.map((item, i) => (
                    <li key={i} className="break-all font-mono text-[11px] leading-relaxed text-fail/90">
                        {item}
                    </li>
                ))}
            </ul>
        </div>
    );
}

function StepRow({
    index,
    step,
    result,
    last,
}: {
    index: number;
    step: TestPlan["steps"][number];
    result: StepResultView | null;
    last: boolean;
}) {
    const state: NodeState = result?.status ?? "pending";
    const action = ACTION[step.action];
    const ActionIcon = action.icon;
    const status = STATUS[state];
    const observedTone = state === "failed" ? "text-fail" : state === "blocked" ? "text-blocked" : undefined;
    const networkErrors = (result?.networkErrors ?? []).map((e) => `${e.status} · ${e.url}`);

    return (
        <li className="flex gap-3 sm:gap-4">
            <div className="flex flex-col items-center">
                <StatusNode state={state} index={index} />
                {!last && <span className="my-1 w-px flex-1 bg-border" />}
            </div>

            <div className="min-w-0 flex-1 pb-5">
                <div className="grid gap-3 rounded-xl border bg-card/40 p-4">
                    <div className="flex items-start justify-between gap-3">
                        <div className="flex min-w-0 flex-wrap items-center gap-2">
                            <span className="inline-flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                                <ActionIcon className="size-3.5" />
                                {action.label}
                            </span>
                            <span className="min-w-0 break-words text-sm font-medium tracking-tight">
                                {step.target}
                            </span>
                        </div>
                        <span
                            className={cn(
                                "inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium",
                                status.pill,
                            )}>
                            {status.icon && <status.icon className="size-3" />}
                            {status.label}
                        </span>
                    </div>

                    {step.value && (
                        <code className="w-fit max-w-full break-all rounded-md bg-muted px-2 py-1 font-mono text-xs text-foreground/80">
                            = {JSON.stringify(step.value)}
                        </code>
                    )}

                    <dl className="grid gap-2">
                        {step.reason && <Detail label="Why" value={step.reason} />}
                        <Detail label="Expected" value={step.expect} />
                        <Detail label="Observed" value={result?.observation || "Not run"} tone={observedTone} />
                    </dl>

                    {result?.consoleErrors.length || networkErrors.length ? (
                        <div className="grid gap-2">
                            <ErrorList title="Console errors" items={result?.consoleErrors ?? []} />
                            <ErrorList title="Failed requests" items={networkErrors} />
                        </div>
                    ) : null}

                    {result?.screenshotUrl && (
                        <a
                            href={result.screenshotUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="group/shot block overflow-hidden rounded-lg border bg-[oklch(0.12_0.004_286)]"
                            title="Open full screenshot">
                            <img
                                src={result.screenshotUrl}
                                alt={`Screen after step ${index + 1}: ${step.target}`}
                                loading="lazy"
                                className="max-h-80 w-full object-cover object-top transition-opacity group-hover/shot:opacity-90"
                            />
                        </a>
                    )}
                </div>
            </div>
        </li>
    );
}

export function RunSteps({ plan, results }: { plan: TestPlan; results: StepResultView[] }) {
    const byIndex = new Map(results.map((r) => [r.index, r]));
    return (
        <ol className="grid">
            {plan.steps.map((step, i) => (
                <StepRow
                    key={i}
                    index={i}
                    step={step}
                    result={byIndex.get(i) ?? null}
                    last={i === plan.steps.length - 1}
                />
            ))}
        </ol>
    );
}
