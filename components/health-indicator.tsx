import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useHealth } from "@/hooks/queries";
import { cn } from "@/lib/utils";

interface Check {
    label: string;
    ok: boolean;
    tip: string;
    /** Color when the check is failing. */
    warn: "fail" | "uncertain";
}

function Dot({ ok, warn }: { ok: boolean; warn: Check["warn"] }) {
    return (
        <span className="relative flex size-2">
            {ok && (
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-pass/60 [animation-duration:2.4s]" />
            )}
            <span
                className={cn(
                    "relative inline-flex size-2 rounded-full",
                    ok ? "bg-pass" : warn === "fail" ? "bg-fail" : "bg-uncertain",
                )}
            />
        </span>
    );
}

export function HealthIndicator() {
    const { data, isError } = useHealth();

    if (isError || !data) {
        return (
            <Tooltip>
                <TooltipTrigger asChild>
                    <span
                        tabIndex={0}
                        role="status"
                        aria-label="Server offline — can't reach the Sentinel server"
                        className="inline-flex items-center gap-2 rounded-full border border-fail/30 bg-fail/10 px-2.5 py-1 text-xs font-medium text-fail outline-none focus-visible:ring-2 focus-visible:ring-ring">
                        <span className="size-2 rounded-full bg-fail" />
                        <span className="hidden sm:inline">Server offline</span>
                    </span>
                </TooltipTrigger>
                <TooltipContent>Can't reach the Sentinel server</TooltipContent>
            </Tooltip>
        );
    }

    const checks: Check[] = [
        {
            label: "GitHub",
            ok: data.ghAuthOk,
            warn: "fail",
            tip: data.ghAuthOk ? "gh CLI authenticated" : "gh CLI not authenticated — run gh auth login",
        },
        {
            label: "LLM",
            ok: data.llmCredOk,
            warn: "fail",
            tip: data.llmCredOk ? "LLM credentials configured" : "LLM credentials missing — set them in Settings",
        },
        {
            label: "Poller",
            ok: data.pollerRunning,
            warn: "uncertain",
            tip: data.pollerRunning ? "Watching repos for @-mentions" : "Mention poller is not running",
        },
    ];

    return (
        <div className="flex items-center gap-1 rounded-full border bg-card/60 px-1.5 py-1">
            {checks.map((c) => (
                <Tooltip key={c.label}>
                    <TooltipTrigger asChild>
                        <span
                            tabIndex={0}
                            role="img"
                            aria-label={`${c.label}: ${c.ok ? "ok" : "failing"}`}
                            className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium text-muted-foreground transition-colors outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
                            <Dot ok={c.ok} warn={c.warn} />
                            <span className="hidden md:inline">{c.label}</span>
                        </span>
                    </TooltipTrigger>
                    <TooltipContent>{c.tip}</TooltipContent>
                </Tooltip>
            ))}
        </div>
    );
}
