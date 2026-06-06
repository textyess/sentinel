import { Langfuse } from "langfuse";

interface Usage {
    input: number;
    output: number;
}

export interface RunTotals {
    inputTokens: number;
    outputTokens: number;
    calls: number;
    costUsd: number;
}

/** Per-1M-token USD rates by model family (estimates — Bedrock EU is in this ballpark). */
const RATES: { match: RegExp; input: number; output: number }[] = [
    { match: /opus/i, input: 15, output: 75 },
    { match: /haiku/i, input: 0.8, output: 4 },
    { match: /sonnet/i, input: 3, output: 15 },
    { match: /gpt-4o-mini/i, input: 0.15, output: 0.6 },
    { match: /gpt-4o|gpt-4\.1/i, input: 2.5, output: 10 },
];

function costFor(model: string, usage: Usage): { input: number; output: number; total: number } {
    const rate = RATES.find((r) => r.match.test(model)) ?? { input: 3, output: 15 };
    const input = (usage.input / 1_000_000) * rate.input;
    const output = (usage.output / 1_000_000) * rate.output;
    return { input, output, total: input + output };
}

// Anchored to globalThis so the per-run trace + cost totals stay genuinely process-global
// (the maxConcurrent=1 invariant relies on it) even when a bundler splits the server.
const state = ((
    globalThis as {
        __sentinelLangfuse?: {
            client: Langfuse | null;
            trace: ReturnType<Langfuse["trace"]> | null;
            totals: RunTotals;
        };
    }
).__sentinelLangfuse ??= {
    client: null,
    trace: null,
    totals: { inputTokens: 0, outputTokens: 0, calls: 0, costUsd: 0 },
});

/** Begin a run trace. Enables Langfuse export when keys are present; cost is tallied either way. */
export function startRun(name: string, metadata: Record<string, unknown>): boolean {
    state.totals.inputTokens = 0;
    state.totals.outputTokens = 0;
    state.totals.calls = 0;
    state.totals.costUsd = 0;
    const secretKey = process.env.LANGFUSE_SECRET_KEY;
    const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
    if (!secretKey || !publicKey) {
        state.client = null;
        state.trace = null;
        return false;
    }
    state.client = new Langfuse({
        secretKey,
        publicKey,
        baseUrl: process.env.LANGFUSE_BASEURL || process.env.LANGFUSE_HOST,
    });
    state.trace = state.client.trace({ name, metadata });
    return true;
}

/** Record one LLM call: tally tokens/cost locally and (if enabled) as a Langfuse generation. */
export function recordGeneration(params: {
    label: string;
    model: string;
    usage: Usage;
    input?: unknown;
    output?: unknown;
}): void {
    const cost = costFor(params.model, params.usage);
    state.totals.inputTokens += params.usage.input;
    state.totals.outputTokens += params.usage.output;
    state.totals.calls += 1;
    state.totals.costUsd += cost.total;
    state.trace?.generation({
        name: params.label,
        model: params.model,
        input: params.input,
        output: params.output,
        usage: {
            input: params.usage.input,
            output: params.usage.output,
            total: params.usage.input + params.usage.output,
            inputCost: cost.input,
            outputCost: cost.output,
            totalCost: cost.total,
        },
    });
}

export function runTotals(): RunTotals {
    return { ...state.totals };
}

export function tracingEnabled(): boolean {
    return state.trace !== null;
}

/** Flush to Langfuse and return the trace id (null if tracing was disabled). */
export async function endRun(): Promise<{ traceId: string | null }> {
    const traceId = state.trace?.id ?? null;
    if (state.client) {
        await state.client.flushAsync().catch(() => {});
    }
    state.client = null;
    state.trace = null;
    return { traceId };
}
