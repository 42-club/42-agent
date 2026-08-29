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

export interface ModelCapabilities {
  contextWindowTokens?: number;
  maxOutputTokens?: number;
}

export interface ModelClient {
  /** Immediately available limits, when the client was configured with them or already resolved them. */
  readonly capabilities?: ModelCapabilities;
  /** Resolve provider/model-specific limits. Implementations should cache successful lookups. */
  getCapabilities?(signal?: AbortSignal): Promise<ModelCapabilities | undefined>;
  /** Estimate all input tokens in the provider-serialized request, excluding generated output. */
  estimateRequestTokens?(request: ModelRequest): number | Promise<number>;
  complete(request: ModelRequest): Promise<ModelResponse>;
  stream?(request: ModelRequest): AsyncIterable<ModelStreamEvent>;
}

export type StreamingModelClient = ModelClient & Required<Pick<ModelClient, "stream">>;

/** The stream method itself is the canonical indication that a client can stream. */
export function supportsModelStreaming(model: ModelClient): model is StreamingModelClient {
  return typeof model.stream === "function";
}

export function estimateTokens(text: string): number {
  // Coarse provider-neutral estimate for compression sizing. Do not use this
  // heuristic as a hard request-admission upper bound.
  let tokens = 0;
  let asciiRunLength = 0;
  for (const character of text) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint <= 0x7F) {
      asciiRunLength += 1;
      continue;
    }
    const bytes = codePoint <= 0x7FF ? 2 : codePoint <= 0xFFFF ? 3 : 4;
    tokens += Math.ceil(asciiRunLength / 2) + Math.ceil(bytes / 3);
    asciiRunLength = 0;
  }
  return tokens + Math.ceil(asciiRunLength / 2);
}

/**
 * Conservative tokenizer-independent upper bound for UTF-8 request payloads.
 * Byte-fallback tokenizers cannot emit more tokens than input bytes.
 */
export function estimateTokenUpperBound(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** Safety-biased fallback for clients without a provider token counter. */
export function estimateModelRequestTokens(request: ModelRequest): number {
  return estimateTokenUpperBound(JSON.stringify({
    systemPrompt: request.systemPrompt,
    messages: request.messages,
    tools: request.tools,
  }));
}

export type ModelStreamEvent =
  | { type: "text_delta"; delta: string }
  | { type: "tool_call"; call: ToolCall }
  | { type: "done"; response?: ModelResponse };
