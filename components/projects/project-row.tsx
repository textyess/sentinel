import { ExternalLinkIcon, MoreHorizontalIcon, PlayIcon, RadarIcon, RefreshCwIcon, Trash2Icon } from "lucide-react";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
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
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useCrawlProject, useDeleteProject, useUpdateBaseline, useVerifyProject } from "@/hooks/queries";
import { ApiError } from "@/lib/api";
import type { ProjectView, RunKind } from "@/lib/types";
import { cn } from "@/lib/utils";

function ReadinessBadge({
    ok,
    label,
    okText,
    warnText,
}: {
    ok: boolean;
    label: string;
    okText: string;
    warnText: string;
}) {
    return (
        <span
            className={cn(
                "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium",
                ok ? "border-pass/25 bg-pass/10 text-pass" : "border-uncertain/25 bg-uncertain/10 text-uncertain",
            )}>
            <span className={cn("size-1.5 rounded-full", ok ? "bg-pass" : "bg-uncertain")} />
            {label}: {ok ? okText : warnText}
        </span>
    );
}

export function ProjectRow({
    project,
    onRun,
}: {
    project: ProjectView;
    onRun: (runId: string, label: string, kind: RunKind) => void;
}) {
    const [pr, setPr] = useState("");
    const [baselineOpen, setBaselineOpen] = useState(false);
    const [removeOpen, setRemoveOpen] = useState(false);

    const verify = useVerifyProject();
    const crawl = useCrawlProject();
    const updateBaseline = useUpdateBaseline();
    const remove = useDeleteProject();

    const ready = project.graphPresent && project.credsConfigured;

    function onVerify(e: FormEvent<HTMLFormElement>) {
        e.preventDefault();
        const n = Number.parseInt(pr, 10);
        if (!n || n <= 0) {
            return;
        }
        verify.mutate(
            { id: project.id, pr: n },
            {
                onSuccess: ({ runId }) => {
                    onRun(runId, `${project.repo} #${n}`, "verify");
                    setPr("");
                },
                onError: (err) => toast.error(err instanceof ApiError ? err.message : "Could not start verify"),
            },
        );
    }

    function onCrawl() {
        crawl.mutate(project.id, {
            onSuccess: ({ runId }) => onRun(runId, `${project.repo} — baseline crawl`, "crawl"),
            onError: (err) => toast.error(err instanceof ApiError ? err.message : "Could not start crawl"),
        });
    }

    function onSaveBaseline(e: FormEvent<HTMLFormElement>) {
        e.preventDefault();
        const value = String(new FormData(e.currentTarget).get("baselineUrl") ?? "").trim();
        updateBaseline.mutate(
            { id: project.id, baselineUrl: value || null },
            {
                onSuccess: () => {
                    toast.success("Baseline URL saved");
                    setBaselineOpen(false);
                },
                onError: (err) => toast.error(err instanceof ApiError ? err.message : "Could not save URL"),
            },
        );
    }

    function onRemove() {
        remove.mutate(project.id, {
            onSuccess: () => {
                toast.success(`Removed ${project.repo}`);
                setRemoveOpen(false);
            },
            onError: (err) => toast.error(err instanceof ApiError ? err.message : "Could not remove project"),
        });
    }

    return (
        <div className="group flex flex-wrap items-center gap-x-3 gap-y-3 rounded-xl border bg-card px-4 py-3.5 transition-colors hover:border-foreground/15">
            <Tooltip>
                <TooltipTrigger asChild>
                    <span
                        className={cn(
                            "mt-1 size-2 shrink-0 self-start rounded-full",
                            ready ? "bg-pass" : "bg-muted-foreground/40",
                        )}
                    />
                </TooltipTrigger>
                <TooltipContent>
                    {ready ? "Ready — auto-verify active" : "Auto-verify paused until baseline + credentials are set"}
                </TooltipContent>
            </Tooltip>

            <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                    <span className="truncate font-medium tracking-tight">{project.repo}</span>
                    <a
                        href={`https://github.com/${project.repo}`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:text-foreground"
                        aria-label="Open on GitHub">
                        <ExternalLinkIcon className="size-3.5" />
                    </a>
                </div>
                <div className="mt-0.5 truncate text-xs text-muted-foreground">
                    {project.adapterKind} · mentions <span className="font-mono">{project.mentionHandle}</span> ·
                    preview “{project.previewEnvIncludes}”
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <ReadinessBadge ok={project.graphPresent} label="baseline" okText="ready" warnText="needs crawl" />
                    <ReadinessBadge ok={project.credsConfigured} label="creds" okText="set" warnText="missing" />
                </div>
            </div>

            <div className="flex items-center gap-1.5">
                <form onSubmit={onVerify} className="flex items-center gap-1.5">
                    <Input
                        value={pr}
                        onChange={(e) => setPr(e.target.value)}
                        inputMode="numeric"
                        placeholder="PR #"
                        aria-label={`PR number to verify for ${project.repo}`}
                        className="h-8 w-20"
                    />
                    <Button type="submit" size="sm" variant="secondary" disabled={verify.isPending || !pr}>
                        <PlayIcon className="size-3.5" />
                        Verify
                    </Button>
                </form>

                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <Button
                            variant="ghost"
                            size="icon"
                            className="size-8 text-muted-foreground"
                            aria-label="More actions">
                            <MoreHorizontalIcon className="size-4" />
                        </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="min-w-48">
                        <DropdownMenuItem onClick={onCrawl} disabled={crawl.isPending}>
                            {project.graphPresent ? <RefreshCwIcon /> : <RadarIcon />}
                            {project.graphPresent ? "Re-crawl baseline" : "Build baseline"}
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => setBaselineOpen(true)}>
                            <ExternalLinkIcon />
                            Edit baseline URL…
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem variant="destructive" onClick={() => setRemoveOpen(true)}>
                            <Trash2Icon />
                            Remove project
                        </DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>
            </div>

            {/* Baseline URL editor */}
            <Dialog open={baselineOpen} onOpenChange={setBaselineOpen}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Baseline URL</DialogTitle>
                        <DialogDescription>
                            The app Sentinel crawls to learn {project.repo}. Leave blank to fall back to
                            <span className="font-mono"> SENTINEL_BASE_URL</span>.
                        </DialogDescription>
                    </DialogHeader>
                    <form onSubmit={onSaveBaseline} className="grid gap-4">
                        <div className="grid gap-1.5">
                            <Label htmlFor={`baseline-${project.id}`}>URL</Label>
                            <Input
                                id={`baseline-${project.id}`}
                                name="baselineUrl"
                                type="url"
                                defaultValue={project.baselineUrl ?? ""}
                                placeholder="https://app.example.com"
                                autoFocus
                            />
                        </div>
                        <DialogFooter>
                            <DialogClose asChild>
                                <Button type="button" variant="ghost">
                                    Cancel
                                </Button>
                            </DialogClose>
                            <Button type="submit" disabled={updateBaseline.isPending}>
                                Save URL
                            </Button>
                        </DialogFooter>
                    </form>
                </DialogContent>
            </Dialog>

            {/* Remove confirmation */}
            <Dialog open={removeOpen} onOpenChange={setRemoveOpen}>
                <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle>Remove {project.repo}?</DialogTitle>
                        <DialogDescription>
                            Sentinel stops watching this repo for mentions. Recorded runs are not deleted.
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <DialogClose asChild>
                            <Button type="button" variant="ghost">
                                Cancel
                            </Button>
                        </DialogClose>
                        <Button variant="destructive" onClick={onRemove} disabled={remove.isPending}>
                            Remove
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}
