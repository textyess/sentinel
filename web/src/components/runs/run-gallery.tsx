import { ClapperboardIcon } from "lucide-react";
import { RunCard } from "@/components/runs/run-card";
import { Skeleton } from "@/components/ui/skeleton";
import { useRuns } from "@/hooks/queries";

export function RunGallery() {
    const { data, isLoading, isError, error } = useRuns();

    if (isLoading) {
        return (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,20rem),1fr))] gap-4">
                {[0, 1, 2].map((i) => (
                    <Skeleton key={i} className="aspect-[4/3] w-full rounded-xl" />
                ))}
            </div>
        );
    }

    if (isError) {
        return (
            <div className="rounded-xl border border-fail/30 bg-fail/5 px-4 py-3 text-sm text-fail">
                {error instanceof Error ? error.message : "Failed to load runs"}
            </div>
        );
    }

    if (!data || data.length === 0) {
        return (
            <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed px-6 py-14 text-center">
                <span className="grid size-11 place-items-center rounded-xl bg-muted text-muted-foreground">
                    <ClapperboardIcon className="size-5" />
                </span>
                <div>
                    <p className="font-medium">No runs yet</p>
                    <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
                        Tag Sentinel on a pull request, or hit <span className="font-medium text-foreground">Verify</span> on a
                        project above. Each run records a video you can replay here.
                    </p>
                </div>
            </div>
        );
    }

    return (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,20rem),1fr))] gap-4">
            {data.map((run, i) => (
                <div key={run.runId} className="animate-fade-up" style={{ animationDelay: `${Math.min(i, 8) * 45}ms` }}>
                    <RunCard run={run} />
                </div>
            ))}
        </div>
    );
}
