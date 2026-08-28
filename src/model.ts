import type { Message } from "./session.js";

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ModelResponse {
  content?: string;
  toolCalls?: ToolCall[];
}

export interface ModelRequest {
  messages: readonly Message[];
  tools: readonly ToolDefinition[];
  systemPrompt: string;
  signal?: AbortSignal;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ModelClient {
  capabilities?: { contextWindowTokens?: number; maxOutputTokens?: number };
  complete(request: ModelRequest): Promise<ModelResponse>;
  stream?(request: ModelRequest): AsyncIterable<ModelStreamEvent>;
}

export type StreamingModelClient = ModelClient & Required<Pick<ModelClient, "stream">>;

/** The stream method itself is the canonical indication that a client can stream. */
export function supportsModelStreaming(model: ModelClient): model is StreamingModelClient {
  return typeof model.stream === "function";
}

export function estimateTokens(text: string): number {
  // Conservative provider-neutral estimate; providers may add an exact counter later.
  return Math.ceil(text.length / 3);
}

export type ModelStreamEvent =
  | { type: "text_delta"; delta: string }
  | { type: "tool_call"; call: ToolCall }
  | { type: "done"; response?: ModelResponse };
