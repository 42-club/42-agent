import {
  estimateTokenUpperBound,
  type ModelCapabilities,
  type ModelClient,
  type ModelRequest,
  type ModelResponse,
  type ModelStreamEvent,
  type ToolCall,
} from "../model.js";
import {
  toOpenAiCompatiblePayload,
  type OpenAiCompatibleToolCall,
} from "./openai-compatible-payload.js";
import { OpenRouterCapabilitiesResolver } from "./openrouter-capabilities.js";

export interface OpenRouterConfig {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  appName?: string;
  httpReferer?: string;
  fetch?: typeof fetch;
  contextWindowTokens?: number;
  maxOutputTokens?: number;
}

export class OpenRouterModelClient implements ModelClient {
  readonly model: string;
  private readonly baseUrl: string;
  private readonly fetcher: typeof fetch;
  private readonly capabilitiesResolver: OpenRouterCapabilitiesResolver;

  constructor(private readonly config: OpenRouterConfig) {
    if (!config.apiKey) throw new Error("OPENROUTER_API_KEY is required");
    this.model = config.model ?? "anthropic/claude-opus-4.6";
    this.baseUrl = (config.baseUrl ?? "https://openrouter.ai/api/v1").replace(/\/$/, "");
    this.fetcher = config.fetch ?? fetch;
    this.capabilitiesResolver = new OpenRouterCapabilitiesResolver({
      apiKey: config.apiKey,
      model: this.model,
      baseUrl: this.baseUrl,
      fetch: this.fetcher,
      contextWindowTokens: config.contextWindowTokens,
      maxOutputTokens: config.maxOutputTokens,
    });
  }

  get capabilities(): ModelCapabilities | undefined {
    return this.capabilitiesResolver.capabilities;
  }

  getCapabilities(signal?: AbortSignal): Promise<ModelCapabilities> {
    return this.capabilitiesResolver.getCapabilities(signal);
  }

  estimateRequestTokens(request: ModelRequest): number {
    return estimateTokenUpperBound(JSON.stringify(this.payload(request, false)));
  }

  static fromEnv(overrides: Partial<OpenRouterConfig> = {}): OpenRouterModelClient {
    return new OpenRouterModelClient({
      apiKey: overrides.apiKey ?? process.env.OPENROUTER_API_KEY ?? "",
      model: overrides.model ?? process.env.OPENROUTER_MODEL ?? "anthropic/claude-opus-4.6",
      baseUrl: overrides.baseUrl,
      appName: overrides.appName ?? process.env.OPENROUTER_APP_NAME ?? "42 Agent",
      httpReferer: overrides.httpReferer ?? process.env.OPENROUTER_HTTP_REFERER,
      fetch: overrides.fetch,
      contextWindowTokens: overrides.contextWindowTokens,
      maxOutputTokens: overrides.maxOutputTokens,
    });
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const response = await this.fetcher(`${this.baseUrl}/chat/completions`, {
      method: "POST", headers: this.headers(), body: JSON.stringify(this.payload(request, false)), signal: request.signal,
    });
    if (!response.ok) throw await responseError(response);
    const body = (await response.json()) as any;
    if (body.error) throw new Error(body.error.message ?? "OpenRouter request failed");
    const message = body.choices?.[0]?.message;
    return { content: message?.content ?? "", toolCalls: parseToolCalls(message?.tool_calls ?? []) };
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    const response = await this.fetcher(`${this.baseUrl}/chat/completions`, {
      method: "POST", headers: this.headers(), body: JSON.stringify(this.payload(request, true)), signal: request.signal,
    });
    if (!response.ok || !response.body) throw await responseError(response);
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();
    let buffer = "";
    let reachedEof = false;
    let sawDone = false;
    try {
      reading: while (true) {
        const { value, done } = await reader.read();
        reachedEof = done;
        buffer += value ?? "";
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const data = trimmed.slice(5).trim();
          if (!data) continue;
          if (data === "[DONE]") {
            sawDone = true;
            break reading;
          }
          const chunk = JSON.parse(data);
          if (chunk.error) throw new Error(chunk.error.message ?? "OpenRouter stream failed");
          const delta = chunk.choices?.[0]?.delta;
          if (delta?.content) yield { type: "text_delta", delta: delta.content };
          for (const fragment of delta?.tool_calls ?? []) {
            const index = Number(fragment.index ?? 0);
            const current = toolCalls.get(index) ?? { id: "", name: "", arguments: "" };
            current.id ||= fragment.id ?? "";
            current.name += fragment.function?.name ?? "";
            current.arguments += fragment.function?.arguments ?? "";
            toolCalls.set(index, current);
          }
        }
        if (done) break;
      }
    } finally {
      try {
        // IteratorClose, parse failures, aborts, and the protocol-level DONE
        // marker must release the underlying fetch connection without waiting
        // for the server to close its keep-alive body.
        if (!reachedEof) await reader.cancel().catch(() => undefined);
      } finally {
        reader.releaseLock();
      }
    }
    if (!sawDone) {
      throw new Error("OpenRouter stream ended before the [DONE] marker");
    }
    for (const call of [...toolCalls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call)) {
      yield { type: "tool_call", call: normalizeToolCall(call.id, call.name, call.arguments) };
    }
    yield { type: "done" };
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.config.apiKey}`,
      "content-type": "application/json",
      "x-openrouter-title": this.config.appName ?? "42 Agent",
    };
    if (this.config.httpReferer) headers["http-referer"] = this.config.httpReferer;
    return headers;
  }

  private payload(request: ModelRequest, stream: boolean): Record<string, unknown> {
    return toOpenAiCompatiblePayload(this.model, request, stream);
  }
}

function parseToolCalls(calls: OpenAiCompatibleToolCall[]): ToolCall[] {
  return calls.map((call) => normalizeToolCall(call.id, call.function.name, call.function.arguments));
}

function normalizeToolCall(id: string, name: string, argumentsJson: string): ToolCall {
  try {
    return { id, name, arguments: argumentsJson ? JSON.parse(argumentsJson) : {} };
  } catch {
    throw new Error(`Invalid tool arguments returned for ${name}`);
  }
}

async function responseError(response: Response): Promise<Error> {
  const text = await response.text();
  return new Error(`OpenRouter ${response.status}: ${text.slice(0, 500)}`);
}
