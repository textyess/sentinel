import type { ProgressEvent, RunKind } from "./types";

export interface Phase {
    key: string;
    label: string;
    /** Matches a progress line that marks entry into this phase. */
    match: RegExp;
}

// Sentinel emits progress lines (see core/verify + crawler). These phase markers
// turn the raw stream into a stepper. The final phase is a sentinel that never
// matches a line — it lights up only when the terminal `done` event arrives.
const NEVER = /^\0$/;

export const VERIFY_PHASES: Phase[] = [
    { key: "plan", label: "Plan", match: /Planning with/i },
    { key: "target", label: "Target", match: /^Target:/ },
    { key: "auth", label: "Auth", match: /Authenticating/i },
    { key: "steps", label: "Steps", match: /step \d+\/\d+/i },
    { key: "judge", label: "Judge", match: /Judging/i },
    { key: "verdict", label: "Verdict", match: NEVER },
];

export const CRAWL_PHASES: Phase[] = [
    { key: "auth", label: "Auth", match: /Authenticating/i },
    { key: "crawl", label: "Crawl", match: /Crawling/i },
    { key: "mapped", label: "Map", match: /Mapped \d/i },
];

export function phasesFor(kind: RunKind): Phase[] {
    return kind === "crawl" ? CRAWL_PHASES : VERIFY_PHASES;
}

/** Highest phase index reached by any line so far. */
export function activePhaseIndex(phases: Phase[], lines: ProgressEvent[]): number {
    let idx = 0;
    for (const { message } of lines) {
        for (let i = idx + 1; i < phases.length; i++) {
            if (phases[i]?.match.test(message)) {
                idx = i;
            }
        }
    }
    return idx;
}
