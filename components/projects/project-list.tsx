import { FolderGit2Icon, PlusIcon } from "lucide-react";
import { ProjectRow } from "@/components/projects/project-row";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useProjects } from "@/hooks/queries";
import type { RunKind } from "@/lib/types";

export function ProjectList({
    onRun,
    onNewProject,
}: {
    onRun: (runId: string, label: string, kind: RunKind) => void;
    onNewProject: () => void;
}) {
    const { data, isLoading, isError, error } = useProjects();

    if (isLoading) {
        return (
            <div className="grid gap-2.5">
                {[0, 1].map((i) => (
                    <Skeleton key={i} className="h-[88px] w-full rounded-xl" />
                ))}
            </div>
        );
    }

    if (isError) {
        return (
            <div className="rounded-xl border border-fail/30 bg-fail/5 px-4 py-3 text-sm text-fail">
                {error instanceof Error ? error.message : "Failed to load projects"}
            </div>
        );
    }

    if (!data || data.length === 0) {
        return (
            <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed px-6 py-12 text-center">
                <span className="grid size-11 place-items-center rounded-xl bg-muted text-muted-foreground">
                    <FolderGit2Icon className="size-5" />
                </span>
                <div>
                    <p className="font-medium">No projects yet</p>
                    <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
                        Add a GitHub repo and Sentinel will crawl a baseline, then verify every PR you tag it on.
                    </p>
                </div>
                <Button onClick={onNewProject} className="mt-1 gap-1.5">
                    <PlusIcon className="size-4" />
                    Add your first project
                </Button>
            </div>
        );
    }

    return (
        <div className="grid gap-2.5">
            {data.map((project, i) => (
                <div key={project.id} className="animate-fade-up" style={{ animationDelay: `${i * 40}ms` }}>
                    <ProjectRow project={project} onRun={onRun} />
                </div>
            ))}
        </div>
    );
}
