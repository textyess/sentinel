"use client";

import {
    AlertTriangleIcon,
    ArrowLeftIcon,
    ExternalLinkIcon,
    FilmIcon,
    GitPullRequestIcon,
    ShieldCheckIcon,
} from "lucide-react";
import Link from "next/link";
import { EyeMark } from "@/components/brand/eye-mark";
import { RunSteps } from "@/components/runs/run-steps";
import { StatusBadge } from "@/components/status-badge";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useRunManifest } from "@/hooks/queries";
import { ApiError } from "@/lib/api";
import type { RunManifestView } from "@/lib/types";
import { cn, timeAgo } from "@/lib/utils";

const VERDICT_ACCENT: Record<string, string> = {
    pass: "border-pass/30 bg-pass/5",
    fail: "border-fail/30 bg-fail/5",
    uncertain: "border-uncertain/30 bg-uncertain/5",
};

function Shell({ children }: { children: React.ReactNode }) {
    return (
        <div className="min-h-screen">
            <header className="sticky top-0 z-30 border-b bg-background/80 backdrop-blur-xl">
                <div className="mx-auto flex h-15 max-w-5xl items-center gap-3 px-4 sm:px-6">
                    <Link href="/" className="flex items-center gap-2.5" aria-label="Back to Sentinel">
                        <EyeMark size={36} className="shrink-0" />
                        <span className="text-lg font-semibold tracking-tight">Sentinel</span>
                    </Link>
                    <div className="ml-auto flex items-center gap-1.5 sm:gap-2">
                        <ThemeToggle />
                    </div>
                </div>
            </header>
            <main className="mx-auto max-w-5xl px-4 pt-6 pb-28 sm:px-6">
                <Link
                    href="/"
                    className="mb-6 inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground">
                    <ArrowLeftIcon className="size-4" />
                    Runs
                </Link>
                {children}
            </main>
        </div>
    );
}

function LoadingState() {
    return (
        <div className="grid gap-6">
            <Skeleton className="h-8 w-2/3" />
            <Skeleton className="h-4 w-1/3" />
            <div className="grid gap-6 lg:grid-cols-5">
                <Skeleton className="aspect-video w-full rounded-xl lg:col-span-3" />
                <Skeleton className="h-48 w-full rounded-xl lg:col-span-2" />
            </div>
            <Skeleton className="h-64 w-full rounded-xl" />
        </div>
    );
}

function EmptyState({ error }: { error: unknown }) {
    const notReady = error instanceof ApiError && error.status === 404;
    const message = error instanceof Error ? error.message : "Something went wrong loading this run.";
    return (
        <div className="mx-auto flex max-w-md flex-col items-center gap-3 rounded-xl border border-dashed px-6 py-16 text-center">
            <span className="grid size-11 place-items-center rounded-xl bg-muted text-muted-foreground">
                <FilmIcon className="size-5" />
            </span>
            <div>
                <p className="font-medium">{notReady ? "Report not ready yet" : "Couldn't load this run"}</p>
                <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
                    {notReady
                        ? "This run is still in progress, or it produced no report. The page refreshes itself when the run settles."
                        : message}
                </p>
            </div>
            <Button asChild variant="outline" size="sm" className="mt-1">
                <Link href="/">Back to runs</Link>
            </Button>
        </div>
    );
}

function Chip({ className, children }: { className?: string; children: React.ReactNode }) {
    return (
        <span
            className={cn(
                "inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] font-medium",
                className,
            )}>
            {children}
        </span>
    );
}

function Stat({ label, value, tone }: { label: string; value: string | number; tone?: string }) {
    return (
        <div className="grid gap-0.5">
            <span className={cn("font-mono text-lg tabular-nums", tone)}>{value}</span>
            <span className="text-xs text-muted-foreground">{label}</span>
        </div>
    );
}

function Hero({ m }: { m: RunManifestView }) {
    const ok = m.results.filter((r) => r.status === "ok").length;
    const failed = m.results.filter((r) => r.status === "failed").length;
    const blocked = m.results.filter((r) => r.status === "blocked").length;

    return (
        <div className="grid gap-6 lg:grid-cols-5">
            <div className="overflow-hidden rounded-xl border bg-[oklch(0.12_0.004_286)] lg:col-span-3">
                {m.videoUrl ? (
                    <video
                        controls
                        preload="metadata"
                        src={m.videoUrl}
                        aria-label={`Recording for ${m.title || `PR #${m.pr}`}`}
                        className="aspect-video w-full object-contain"
                    />
                ) : (
                    <div className="flex aspect-video w-full flex-col items-center justify-center gap-2 text-muted-foreground">
                        <FilmIcon className="size-6 opacity-60" />
                        <span className="text-xs">no recording</span>
                    </div>
                )}
            </div>

            <div className="grid content-start gap-4 lg:col-span-2">
                <div
                    className={cn(
                        "grid gap-3 rounded-xl border p-4",
                        VERDICT_ACCENT[m.verdict.outcome] ?? "border-border",
                    )}>
                    <div className="flex items-center gap-2">
                        <StatusBadge status={m.status} />
                        <span className="text-xs text-muted-foreground">{m.verdict.confidence} confidence</span>
                    </div>
                    <p className="text-sm leading-relaxed text-foreground/90">{m.verdict.summary}</p>
                    {m.verdict.evidence.length > 0 && (
                        <ul className="grid gap-1.5 border-t pt-3">
                            {m.verdict.evidence.map((item, i) => (
                                <li key={i} className="flex gap-2 text-xs text-muted-foreground">
                                    <span className="text-muted-foreground/50">—</span>
                                    <span>{item}</span>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>

                <div className="grid grid-cols-4 gap-3 rounded-xl border p-4">
                    <Stat label="Steps" value={m.plan.steps.length} />
                    <Stat label="Passed" value={ok} tone={ok > 0 ? "text-pass" : undefined} />
                    <Stat label="Failed" value={failed} tone={failed > 0 ? "text-fail" : undefined} />
                    <Stat label="Blocked" value={blocked} tone={blocked > 0 ? "text-blocked" : undefined} />
                </div>
            </div>
        </div>
    );
}

function SkillDriftNote({ results }: { results: RunManifestView["results"] }) {
    const drift = results.flatMap((r) => r.discrepancies ?? []);
    if (drift.length === 0) {
        return null;
    }
    return (
        <div className="grid gap-2 rounded-xl border border-uncertain/30 bg-uncertain/5 p-4">
            <div className="flex flex-wrap items-center gap-2">
                <AlertTriangleIcon className="size-4 text-uncertain" />
                <span className="text-sm font-medium">Navigation skill may be out of date</span>
                <span className="text-xs text-muted-foreground">
                    {drift.length} divergence{drift.length === 1 ? "" : "s"} from the baseline
                </span>
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">
                The baseline navigation skill diverged from the preview. The preview is the changed app, so this is
                often the PR's intended change — it was weighed into the verdict, not treated as a defect. Refresh the
                skill out of band with a baseline re-crawl.
            </p>
            <ul className="grid gap-1 border-t border-uncertain/20 pt-2">
                {drift.slice(0, 6).map((d, i) => (
                    <li key={i} className="flex gap-2 text-xs text-foreground/80">
                        <code className="shrink-0 rounded bg-muted px-1 py-0.5 font-mono text-[10px]">{d.kind}</code>
                        <span className="min-w-0">
                            <span className="font-mono text-muted-foreground">{d.route}</span> — {d.detail}
                        </span>
                    </li>
                ))}
                {drift.length > 6 && <li className="text-xs text-muted-foreground">…and {drift.length - 6} more</li>}
            </ul>
        </div>
    );
}

function Section({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
    return (
        <section className="grid gap-4">
            <div className="grid gap-1">
                <h2 className="text-base font-semibold tracking-tight">{title}</h2>
                {subtitle && <p className="text-sm text-muted-foreground">{subtitle}</p>}
            </div>
            {children}
        </section>
    );
}

function ContextRow({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div className="grid grid-cols-[7rem_1fr] gap-3 py-2 text-sm sm:grid-cols-[9rem_1fr]">
            <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
            <dd className="min-w-0 text-foreground/90">{children}</dd>
        </div>
    );
}

function Report({ m }: { m: RunManifestView }) {
    const hasRepo = m.repo.includes("/");
    const shortSha = m.headSha ? m.headSha.slice(0, 7) : null;

    return (
        <div className="grid gap-10">
            <header className="grid gap-3">
                <div className="flex flex-wrap items-center gap-2">
                    <Chip className="border-primary/30 bg-primary/10 text-primary">
                        <GitPullRequestIcon className="size-3.5" />
                        PR verify
                    </Chip>
                    <StatusBadge status={m.status} />
                    {m.readOnly && (
                        <Chip className="border-pass/30 bg-pass/10 text-pass">
                            <ShieldCheckIcon className="size-3.5" />
                            Read-only
                        </Chip>
                    )}
                </div>
                <h1 className="text-2xl font-semibold tracking-tight">{m.title || `PR #${m.pr}`}</h1>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
                    <span className="truncate">{m.repo}</span>
                    <span aria-hidden>·</span>
                    {hasRepo ? (
                        <a
                            href={`https://github.com/${m.repo}/pull/${m.pr}`}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-0.5 font-medium text-primary hover:underline">
                            PR #{m.pr}
                            <ExternalLinkIcon className="size-3" />
                        </a>
                    ) : (
                        <span>PR #{m.pr}</span>
                    )}
                    <span aria-hidden>·</span>
                    <span>{timeAgo(m.createdAt)}</span>
                    <span aria-hidden>·</span>
                    <span className="font-mono text-xs">{m.model}</span>
                </div>
            </header>

            <Hero m={m} />

            <SkillDriftNote results={m.results} />

            <Section title="Plan" subtitle={m.plan.goal}>
                <div className="grid gap-4">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
                        <span className="text-xs font-medium">Starts at</span>
                        <code className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground/80">
                            {m.plan.startRoute || "/"}
                        </code>
                    </div>
                    {m.plan.notes.length > 0 && (
                        <ul className="grid gap-1.5 rounded-xl border border-uncertain/25 bg-uncertain/5 p-3">
                            {m.plan.notes.map((note, i) => (
                                <li key={i} className="flex gap-2 text-xs text-foreground/80">
                                    <span className="text-uncertain">note</span>
                                    <span>{note}</span>
                                </li>
                            ))}
                        </ul>
                    )}
                    <RunSteps plan={m.plan} results={m.results} />
                </div>
            </Section>

            <Section title="Context" subtitle="What this run targeted and looked at.">
                <dl className="divide-y rounded-xl border px-4">
                    <ContextRow label="Target">
                        <a
                            href={m.targetUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-0.5 break-all text-primary hover:underline">
                            {m.targetUrl}
                            <ExternalLinkIcon className="size-3 shrink-0" />
                        </a>
                    </ContextRow>
                    {m.headRef && (
                        <ContextRow label="Branch">
                            <span className="font-mono text-xs">
                                {m.headRef}
                                {shortSha ? ` @ ${shortSha}` : ""}
                            </span>
                        </ContextRow>
                    )}
                    {m.affectedRoutes.length > 0 && (
                        <ContextRow label="Affected routes">
                            <div className="flex flex-wrap gap-1.5">
                                {m.affectedRoutes.map((route) => (
                                    <code
                                        key={route}
                                        className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground/80">
                                        {route}
                                    </code>
                                ))}
                            </div>
                        </ContextRow>
                    )}
                    {m.changedFiles.length > 0 && (
                        <ContextRow label={`Changed files (${m.changedFiles.length})`}>
                            <ul className="grid gap-0.5">
                                {m.changedFiles.map((file) => (
                                    <li key={file} className="break-all font-mono text-xs text-foreground/80">
                                        {file}
                                    </li>
                                ))}
                            </ul>
                        </ContextRow>
                    )}
                    <ContextRow label="Write boundary">
                        <span className="text-sm">
                            {m.readOnly ? "Read-only enforced" : "Writes allowed"}
                            {m.blockedWrites > 0 && (
                                <span className="text-muted-foreground">
                                    {" "}
                                    · {m.blockedWrites} mutation{m.blockedWrites === 1 ? "" : "s"} blocked
                                </span>
                            )}
                        </span>
                    </ContextRow>
                </dl>
                {m.body.trim() && (
                    <details className="rounded-xl border px-4 py-3">
                        <summary className="cursor-pointer text-sm font-medium text-foreground/90">
                            PR description
                        </summary>
                        <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">
                            {m.body.trim()}
                        </p>
                    </details>
                )}
            </Section>
        </div>
    );
}

export function RunReport({ runId }: { runId: string }) {
    const { data, isLoading, isError, error } = useRunManifest(runId);

    return (
        <Shell>
            {isLoading ? <LoadingState /> : data ? <Report m={data} /> : <EmptyState error={isError ? error : null} />}
        </Shell>
    );
}
