import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, jsonSchema, streamText, tool, type LanguageModel } from "ai";
import type { ModelClient, ModelRequest, ModelResponse, ModelStreamEvent, ToolCall } from "../model.js";
import type { Message } from "../session.js";

/** Keeps AI SDK provider and streaming details behind the runtime's ModelClient boundary. */
export class AiSdkModelClient implements ModelClient {
  constructor(readonly model: LanguageModel) {}

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
}

export function createAiSdkOpenRouterClient(config: AiSdkOpenRouterConfig): AiSdkModelClient {
  const provider = createOpenAICompatible({
    name: "openrouter",
    baseURL: config.baseUrl ?? "https://openrouter.ai/api/v1",
    apiKey: config.apiKey,
    headers: {
      "X-OpenRouter-Title": config.appName ?? "42 Agent",
      ...(config.httpReferer ? { "HTTP-Referer": config.httpReferer } : {}),
    },
  });
  return new AiSdkModelClient(provider.chatModel(config.model));
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
