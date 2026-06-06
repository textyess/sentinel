import { PlusIcon, SettingsIcon, ShieldCheckIcon } from "lucide-react";
import { HealthIndicator } from "@/components/health-indicator";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";

export function TopBar({
    onOpenSettings,
    onNewProject,
}: {
    onOpenSettings: () => void;
    onNewProject: () => void;
}) {
    return (
        <header className="sticky top-0 z-30 border-b bg-background/80 backdrop-blur-xl">
            <div className="mx-auto flex h-15 max-w-6xl items-center gap-3 px-4 sm:px-6">
                <div className="flex items-center gap-2.5">
                    <span className="grid size-8 place-items-center rounded-lg bg-primary/12 text-primary ring-1 ring-inset ring-primary/20">
                        <ShieldCheckIcon className="size-4.5" />
                    </span>
                    <div className="leading-tight">
                        <div className="text-sm font-semibold tracking-tight">Sentinel</div>
                        <div className="hidden text-xs text-muted-foreground sm:block">
                            Learns your app, then watches your PRs
                        </div>
                    </div>
                </div>

                <div className="ml-auto flex items-center gap-1.5 sm:gap-2">
                    <HealthIndicator />
                    <ThemeToggle />
                    <Button
                        variant="ghost"
                        size="icon"
                        className="text-muted-foreground"
                        onClick={onOpenSettings}
                        aria-label="Settings"
                    >
                        <SettingsIcon className="size-4.5" />
                    </Button>
                    <Button size="sm" className="gap-1.5" onClick={onNewProject}>
                        <PlusIcon className="size-4" />
                        <span className="hidden sm:inline">New project</span>
                    </Button>
                </div>
            </div>
        </header>
    );
}
