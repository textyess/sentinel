import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import { type CoreMessage, generateObject, generateText } from "ai";
import type { EnvConfig } from "../config";
import { recordGeneration } from "../observability/langfuse";
import type { GenerateObjectOptions, GenerateTextOptions, Reasoner } from "./types";

/** The exact model type the AI SDK's generate* functions accept — provider-agnostic. */
type ChatModel = Parameters<typeof generateText>[0]["model"];

/** A user message carrying the prompt text plus any images, for vision-capable calls. */
function imageMessages(prompt: string, images: Buffer[]): CoreMessage[] {
    return [
        {
            role: "user",
            content: [{ type: "text", text: prompt }, ...images.map((image) => ({ type: "image" as const, image }))],
        },
    ];
}

/** A {@link Reasoner} backed by the Vercel AI SDK (Anthropic, OpenAI, or Claude-on-Bedrock). */
class AiSdkReasoner implements Reasoner {
    readonly modelLabel: string;
    private readonly model: ChatModel;

    constructor(model: ChatModel, modelLabel: string) {
        this.model = model;
        this.modelLabel = modelLabel;
    }

    async generateText(options: GenerateTextOptions): Promise<string> {
        const result = options.images?.length
            ? await generateText({
                  model: this.model,
                  system: options.system,
                  messages: imageMessages(options.prompt, options.images),
                  maxTokens: options.maxTokens,
              })
            : await generateText({
                  model: this.model,
                  system: options.system,
                  prompt: options.prompt,
                  maxTokens: options.maxTokens,
              });
        this.track(options.telemetryLabel, result.usage, options.prompt, result.text);
        return result.text;
    }

    async generateObject<T>(options: GenerateObjectOptions<T>): Promise<T> {
        const result = options.images?.length
            ? await generateObject({
                  model: this.model,
                  system: options.system,
                  messages: imageMessages(options.prompt, options.images),
                  schema: options.schema,
                  maxTokens: options.maxTokens,
              })
            : await generateObject({
                  model: this.model,
                  system: options.system,
                  prompt: options.prompt,
                  schema: options.schema,
                  maxTokens: options.maxTokens,
              });
        this.track(options.telemetryLabel, result.usage, options.prompt, result.object);
        return result.object;
    }

    private track(
        label: string | undefined,
        usage: { promptTokens: number; completionTokens: number },
        input: unknown,
        output: unknown,
    ): void {
        recordGeneration({
            label: label ?? "llm",
            model: this.modelLabel,
            usage: { input: usage.promptTokens, output: usage.completionTokens },
            input,
            output,
        });
    }
}

/** Claude on Amazon Bedrock (EU inference profiles, AWS SigV4 creds). */
function bedrockModel(modelId: string): ChatModel {
    const bedrock = createAmazonBedrock({
        region: process.env.AWS_REGION || "eu-central-1",
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        sessionToken: process.env.AWS_SESSION_TOKEN,
    });
    return bedrock(modelId);
}

export function createReasoner(env: EnvConfig): Reasoner {
    let model: ChatModel;
    if (env.llmProvider === "openai") {
        model = openai(env.llmModel);
    } else if (env.llmProvider === "bedrock") {
        model = bedrockModel(env.llmModel);
    } else {
        model = anthropic(env.llmModel);
    }
    return new AiSdkReasoner(model, `${env.llmProvider}:${env.llmModel}`);
}

/** Returns a human-readable problem if the chosen provider's credentials are missing, else null. */
export function llmCredentialIssue(provider: EnvConfig["llmProvider"]): string | null {
    if (provider === "openai") {
        return process.env.OPENAI_API_KEY ? null : "OPENAI_API_KEY is not set";
    }
    if (provider === "bedrock") {
        return process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
            ? null
            : "AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY are not set (and AWS_REGION for Bedrock)";
    }
    return process.env.ANTHROPIC_API_KEY ? null : "ANTHROPIC_API_KEY is not set";
}
