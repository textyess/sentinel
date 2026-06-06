"use client";

import { PlusIcon } from "lucide-react";
import { useState } from "react";
import { type ActiveRun, LiveRunSheet } from "@/components/live/live-run-sheet";
import { ProjectList } from "@/components/projects/project-list";
import { RegisterProjectDialog } from "@/components/projects/register-project-dialog";
import { RunGallery } from "@/components/runs/run-gallery";
import { SettingsSheet } from "@/components/settings/settings-sheet";
import { TopBar } from "@/components/top-bar";
import { Button } from "@/components/ui/button";
import { useProjects, useRuns } from "@/hooks/queries";
import type { RunKind } from "@/lib/types";

function Count({ value }: { value: number | undefined }) {
    if (value === undefined) {
        return null;
    }
    return (
        <span className="rounded-full bg-muted px-1.5 py-0.5 text-xs font-medium text-muted-foreground tabular-nums">
            {value}
        </span>
    );
}

export default function Page() {
    const [registerOpen, setRegisterOpen] = useState(false);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [activeRun, setActiveRun] = useState<ActiveRun | null>(null);

    const projects = useProjects();
    const runs = useRuns();

    function openRun(runId: string, label: string, kind: RunKind) {
        setActiveRun({ runId, label, kind });
    }

    return (
        <div className="min-h-screen">
            <TopBar onOpenSettings={() => setSettingsOpen(true)} onNewProject={() => setRegisterOpen(true)} />

            <main className="mx-auto max-w-6xl space-y-12 px-4 pt-10 pb-28 sm:px-6">
                <section>
                    <div className="mb-4 flex items-center justify-between">
                        <div className="flex items-center gap-2">
                            <h2 className="text-base font-semibold tracking-tight">Projects</h2>
                            <Count value={projects.data?.length} />
                        </div>
                        <Button
                            variant="ghost"
                            size="sm"
                            className="gap-1.5 text-muted-foreground"
                            onClick={() => setRegisterOpen(true)}>
                            <PlusIcon className="size-4" />
                            Add
                        </Button>
                    </div>
                    <ProjectList onRun={openRun} onNewProject={() => setRegisterOpen(true)} />
                </section>

                <section>
                    <div className="mb-4 flex items-center gap-2">
                        <h2 className="text-base font-semibold tracking-tight">Runs</h2>
                        <Count value={runs.data?.length} />
                        <span className="ml-auto hidden text-xs text-muted-foreground sm:inline">auto-refreshing</span>
                    </div>
                    <RunGallery />
                </section>
            </main>

            <RegisterProjectDialog open={registerOpen} onOpenChange={setRegisterOpen} />
            <SettingsSheet open={settingsOpen} onOpenChange={setSettingsOpen} />
            <LiveRunSheet activeRun={activeRun} onOpenChange={(open) => !open && setActiveRun(null)} />
        </div>
    );
}
