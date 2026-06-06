import { useEffect, useRef } from "react";
import type { LogLevel, ProgressEvent } from "@/lib/types";
import { cn } from "@/lib/utils";

const GLYPH: Record<LogLevel, { mark: string; className: string }> = {
    success: { mark: "✓", className: "text-pass" },
    error: { mark: "✕", className: "text-fail" },
    warn: { mark: "!", className: "text-uncertain" },
    info: { mark: "·", className: "text-muted-foreground" },
    debug: { mark: "·", className: "text-muted-foreground/70" },
};

export function RunLog({ lines, streaming }: { lines: ProgressEvent[]; streaming: boolean }) {
    const endRef = useRef<HTMLDivElement>(null);

    // Keep the newest line in view as the stream grows.
    useEffect(() => {
        endRef.current?.scrollIntoView({ block: "end" });
    }, [lines.length]);

    return (
        <div className="h-full overflow-auto rounded-lg border bg-[oklch(0.14_0.004_286)] p-3 font-mono text-xs leading-relaxed">
            {lines.length === 0 && (
                <div className="text-muted-foreground/70">{streaming ? "Waiting for the agent…" : "No output."}</div>
            )}
            {lines.map((line, i) => {
                const g = GLYPH[line.level] ?? GLYPH.info;
                return (
                    <div key={i} className="flex gap-2 whitespace-pre-wrap break-words">
                        <span className={cn("select-none", g.className)}>{g.mark}</span>
                        <span className="text-foreground/85">{line.message}</span>
                    </div>
                );
            })}
            {streaming && (
                <span className="mt-0.5 inline-block h-3.5 w-1.5 animate-pulse bg-running align-middle" aria-hidden />
            )}
            <div ref={endRef} />
        </div>
    );
}
