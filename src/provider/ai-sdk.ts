import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, jsonSchema, streamText, tool, type LanguageModel } from "ai";
import {
  estimateModelRequestTokens,
  estimateTokenUpperBound,
  type ModelCapabilities,
  type ModelClient,
  type ModelRequest,
  type ModelResponse,
  type ModelStreamEvent,
  type ToolCall,
} from "../model.js";
import type { Message } from "../session.js";
import { toOpenAiCompatiblePayload } from "./openai-compatible-payload.js";
import { OpenRouterCapabilitiesResolver } from "./openrouter-capabilities.js";

export interface AiSdkModelClientOptions {
  capabilities?: ModelCapabilities;
  resolveCapabilities?: (signal?: AbortSignal) => Promise<ModelCapabilities | undefined>;
  estimateRequestTokens?: (request: ModelRequest) => number | Promise<number>;
}

/** Keeps AI SDK provider and streaming details behind the runtime's ModelClient boundary. */
export class AiSdkModelClient implements ModelClient {
  private resolvedCapabilities?: ModelCapabilities;

  constructor(
    readonly model: LanguageModel,
    private readonly options: AiSdkModelClientOptions = {},
  ) {
    this.resolvedCapabilities = options.capabilities
      ? Object.freeze({ ...options.capabilities })
      : undefined;
  }

  get capabilities(): ModelCapabilities | undefined {
    return this.resolvedCapabilities;
  }

  async getCapabilities(signal?: AbortSignal): Promise<ModelCapabilities | undefined> {
    if (this.resolvedCapabilities?.contextWindowTokens !== undefined) {
      return this.resolvedCapabilities;
    }
    const capabilities = await this.options.resolveCapabilities?.(signal);
    if (capabilities) this.resolvedCapabilities = Object.freeze({ ...capabilities });
    return capabilities ?? this.resolvedCapabilities;
  }

  estimateRequestTokens(request: ModelRequest): number | Promise<number> {
    return this.options.estimateRequestTokens?.(request)
      ?? estimateModelRequestTokens(request);
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const result = await generateText({
      model: this.model,
      system: request.systemPrompt,
      messages: toAiMessages(request.messages),
      tools: toAiTools(request),
      abortSignal: request.signal,
      maxRetries: 0,
    });
    return {
      content: result.text,
      toolCalls: result.toolCalls.map((call) => ({
        id: call.toolCallId, name: call.toolName, arguments: call.input as Record<string, unknown>,
      })),
    };
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    const result = streamText({
      model: this.model,
      system: request.systemPrompt,
      messages: toAiMessages(request.messages),
      tools: toAiTools(request),
      abortSignal: request.signal,
      maxRetries: 0,
      // Errors are surfaced through fullStream below. Suppress the SDK's
      // default console reporter so embedding applications own logging.
      onError: () => undefined,
    });
    for await (const part of result.fullStream) {
      if (part.type === "text-delta") yield { type: "text_delta", delta: part.text };
      else if (part.type === "tool-call") {
        yield {
          type: "tool_call",
          call: { id: part.toolCallId, name: part.toolName, arguments: part.input as Record<string, unknown> },
        };
      } else if (part.type === "error") {
        throw part.error;
      } else if (part.type === "abort") {
        throw request.signal?.reason
          ?? new DOMException(part.reason ?? "AI SDK stream aborted", "AbortError");
      } else if (part.type === "finish") {
        yield { type: "done" };
        return;
      }
    }
    throw new Error("AI SDK stream ended before a finish event");
  }
}

export interface AiSdkOpenRouterConfig {
  apiKey: string;
  model: string;
  baseUrl?: string;
  appName?: string;
  httpReferer?: string;
  fetch?: typeof fetch;
  contextWindowTokens?: number;
  maxOutputTokens?: number;
}

export function createAiSdkOpenRouterClient(config: AiSdkOpenRouterConfig): AiSdkModelClient {
  const baseUrl = (config.baseUrl ?? "https://openrouter.ai/api/v1").replace(/\/$/, "");
  const fetcher = config.fetch ?? fetch;
  const provider = createOpenAICompatible({
    name: "openrouter",
    baseURL: baseUrl,
    apiKey: config.apiKey,
    fetch: fetcher,
    headers: {
      "X-OpenRouter-Title": config.appName ?? "42 Agent",
      ...(config.httpReferer ? { "HTTP-Referer": config.httpReferer } : {}),
    },
  });
  const capabilities = new OpenRouterCapabilitiesResolver({
    apiKey: config.apiKey,
    model: config.model,
    baseUrl,
    fetch: fetcher,
    contextWindowTokens: config.contextWindowTokens,
    maxOutputTokens: config.maxOutputTokens,
  });
  return new AiSdkModelClient(provider.chatModel(config.model), {
    capabilities: capabilities.capabilities,
    resolveCapabilities: (signal) => capabilities.getCapabilities(signal),
    estimateRequestTokens: (request) => estimateAiSdkOpenRouterRequestTokens(
      config.model,
      request,
    ),
  });
}

function estimateAiSdkOpenRouterRequestTokens(model: string, request: ModelRequest): number {
  const payload = toOpenAiCompatiblePayload(model, request, true);
  if (request.tools.length > 0) {
    return estimateTokenUpperBound(JSON.stringify({ ...payload, tool_choice: "auto" }));
  }
  const { tools: _tools, ...withoutEmptyTools } = payload;
  return estimateTokenUpperBound(JSON.stringify(withoutEmptyTools));
}

function toAiTools(request: ModelRequest): Record<string, ReturnType<typeof tool>> {
  return Object.fromEntries(request.tools.map((definition) => [definition.name, tool({
    description: definition.description,
    inputSchema: jsonSchema(definition.inputSchema),
  })]));
}

function toAiMessages(messages: readonly Message[]): any[] {
  return messages.map((message) => {
    if (message.role === "assistant") {
      const calls = (message.metadata?.toolCalls as ToolCall[] | undefined) ?? [];
      return calls.length
        ? { role: "assistant", content: [
            ...(message.content ? [{ type: "text", text: message.content }] : []),
            ...calls.map((call) => ({ type: "tool-call", toolCallId: call.id, toolName: call.name, input: call.arguments })),
          ] }
        : { role: "assistant", content: message.content };
    }
    if (message.role === "tool") {
      return { role: "tool", content: [{
        type: "tool-result", toolCallId: message.toolCallId, toolName: message.name,
        output: { type: "json", value: parseJson(message.content) },
      }] };
    }
    return { role: message.role, content: message.content };
  });
}

function parseJson(value: string): unknown {
  try { return JSON.parse(value); } catch { return value; }
}
