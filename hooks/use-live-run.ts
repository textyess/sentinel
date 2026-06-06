import { useEffect, useRef, useState } from "react";
import { eventsUrl } from "@/lib/api";
import type { DoneEvent, ProgressEvent } from "@/lib/types";

export interface LiveRunState {
    lines: ProgressEvent[];
    done: DoneEvent | null;
    error: string | null;
    /** True while the EventSource is open and no terminal event has arrived. */
    streaming: boolean;
}

const INITIAL: LiveRunState = { lines: [], done: null, error: null, streaming: false };

/**
 * Subscribe to a run's SSE stream. Pass `null` to disconnect. Resets cleanly when
 * the runId changes so reusing the panel for a new run never leaks the old stream.
 */
export function useLiveRun(runId: string | null): LiveRunState {
    const [state, setState] = useState<LiveRunState>(INITIAL);
    const sourceRef = useRef<EventSource | null>(null);

    useEffect(() => {
        sourceRef.current?.close();
        if (!runId) {
            setState(INITIAL);
            return;
        }

        setState({ ...INITIAL, streaming: true });
        const source = new EventSource(eventsUrl(runId));
        sourceRef.current = source;

        source.addEventListener("progress", (ev) => {
            try {
                const line = JSON.parse((ev as MessageEvent).data) as ProgressEvent;
                setState((s) => ({ ...s, lines: [...s.lines, line] }));
            } catch {
                // ignore malformed frames
            }
        });

        source.addEventListener("done", (ev) => {
            try {
                const done = JSON.parse((ev as MessageEvent).data) as DoneEvent;
                setState((s) => ({ ...s, done, streaming: false }));
            } catch {
                setState((s) => ({ ...s, streaming: false }));
            }
            source.close();
        });

        source.addEventListener("error", (ev) => {
            const data = (ev as MessageEvent).data;
            if (data) {
                try {
                    const { message } = JSON.parse(data) as { message: string };
                    setState((s) => ({ ...s, error: message, streaming: false }));
                    source.close();
                    return;
                } catch {
                    // fall through — a transport-level error has no payload
                }
            }
            // Browser-level connection blip; EventSource will retry on its own.
        });

        return () => {
            source.close();
            sourceRef.current = null;
        };
    }, [runId]);

    return state;
}
