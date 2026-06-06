import { useState } from "react";
import { FilmIcon, Loader2Icon, XIcon } from "lucide-react";
import { toast } from "sonner";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogClose,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Card } from "@/components/ui/card";
import { useDeleteRun } from "@/hooks/queries";
import { ApiError } from "@/lib/api";
import type { RunSummary } from "@/lib/types";
import { timeAgo } from "@/lib/utils";

function Placeholder({ status }: { status: RunSummary["status"] }) {
    const recording = status === "running" || status === "queued";
    return (
        <div className="flex size-full flex-col items-center justify-center gap-2 text-muted-foreground">
            {recording ? (
                <>
                    <Loader2Icon className="size-5 animate-spin text-running" />
                    <span className="text-xs">recording…</span>
                </>
            ) : (
                <>
                    <FilmIcon className="size-5 opacity-60" />
                    <span className="text-xs">no recording</span>
                </>
            )}
        </div>
    );
}

export function RunCard({ run }: { run: RunSummary }) {
    const [confirmOpen, setConfirmOpen] = useState(false);
    const remove = useDeleteRun();
    const hasRepo = run.repo.includes("/");

    function onDismiss() {
        remove.mutate(run.runId, {
            onSuccess: () => setConfirmOpen(false),
            onError: (err) => toast.error(err instanceof ApiError ? err.message : "Could not remove run"),
        });
    }

    return (
        <Card className="group gap-0 overflow-hidden p-0 transition-colors hover:border-foreground/15">
            <div className="relative aspect-video overflow-hidden bg-[oklch(0.12_0.004_286)]">
                {run.videoUrl ? (
                    <video
                        controls
                        preload="metadata"
                        src={run.videoUrl}
                        aria-label={`Recording for ${run.title || `PR #${run.pr}`}`}
                        className="size-full object-contain"
                    />
                ) : (
                    <Placeholder status={run.status} />
                )}
                <div className="pointer-events-none absolute top-2.5 left-2.5">
                    <StatusBadge status={run.status} className="backdrop-blur-md" />
                </div>
                <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => setConfirmOpen(true)}
                    aria-label="Remove run"
                    className="absolute top-1.5 right-1.5 size-7 bg-background/40 text-foreground/80 opacity-0 backdrop-blur-md transition group-hover:opacity-100 hover:bg-background/70 hover:text-fail"
                >
                    <XIcon className="size-3.5" />
                </Button>
            </div>

            <div className="grid gap-2 p-4">
                <div className="flex items-start justify-between gap-2">
                    <h3 className="truncate text-sm font-medium tracking-tight" title={run.title || `PR #${run.pr}`}>
                        {run.title || `PR #${run.pr}`}
                    </h3>
                    {hasRepo ? (
                        <a
                            href={`https://github.com/${run.repo}/pull/${run.pr}`}
                            target="_blank"
                            rel="noreferrer"
                            className="shrink-0 text-xs font-medium text-primary hover:underline"
                        >
                            #{run.pr} ↗
                        </a>
                    ) : (
                        <span className="shrink-0 text-xs text-muted-foreground">#{run.pr}</span>
                    )}
                </div>
                <div className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
                    <span className="truncate">{run.repo}</span>
                    <span aria-hidden>·</span>
                    <span>{timeAgo(run.createdAt)}</span>
                    {run.confidence && (
                        <>
                            <span aria-hidden>·</span>
                            <span>{run.confidence} confidence</span>
                        </>
                    )}
                </div>
                {run.summary && <p className="line-clamp-3 text-sm text-muted-foreground">{run.summary}</p>}
            </div>

            <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
                <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle>Remove this run?</DialogTitle>
                        <DialogDescription>
                            Drops the run from the gallery and deletes its recording and screenshots from disk.
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <DialogClose asChild>
                            <Button type="button" variant="ghost">
                                Cancel
                            </Button>
                        </DialogClose>
                        <Button variant="destructive" onClick={onDismiss} disabled={remove.isPending}>
                            Remove
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </Card>
    );
}
