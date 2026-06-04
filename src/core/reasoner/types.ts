import type { ZodType } from "zod";

/**
 * The LLM reasoning layer, kept behind a small interface so the engine never
 * depends on a concrete provider. The AI SDK backing is one implementation; a
 * brain0/Agno-endpoint backing could be another without touching callers.
 */
export interface GenerateTextOptions {
    prompt: string;
    system?: string;
    maxTokens?: number;
    /** Optional images (e.g. a screenshot) for visual reasoning. */
    images?: Buffer[];
    /** Label for cost tracking / the Langfuse generation name. */
    telemetryLabel?: string;
}

export interface GenerateObjectOptions<T> {
    prompt: string;
    system?: string;
    /** Zod schema the model output is validated against. */
    schema: ZodType<T>;
    maxTokens?: number;
    /** Optional images (e.g. a screenshot) for visual reasoning. */
    images?: Buffer[];
    /** Label for cost tracking / the Langfuse generation name. */
    telemetryLabel?: string;
}

export interface Reasoner {
    /** Human-readable model identifier, e.g. "anthropic:claude-3-5-sonnet-latest". */
    readonly modelLabel: string;
    generateText(options: GenerateTextOptions): Promise<string>;
    generateObject<T>(options: GenerateObjectOptions<T>): Promise<T>;
}
