import type { ModelClient, ModelRequest, ModelResponse, ModelStreamEvent, ToolCall } from "../model.js";
import type { Message } from "../session.js";

export interface OpenRouterConfig {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  appName?: string;
  httpReferer?: string;
  fetch?: typeof fetch;
}

interface OpenRouterToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface OpenRouterMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: OpenRouterToolCall[];
}

export class OpenRouterModelClient implements ModelClient {
  readonly model: string;
  private readonly baseUrl: string;
  private readonly fetcher: typeof fetch;

  constructor(private readonly config: OpenRouterConfig) {
    if (!config.apiKey) throw new Error("OPENROUTER_API_KEY is required");
    this.model = config.model ?? "anthropic/claude-opus-4.6";
    this.baseUrl = (config.baseUrl ?? "https://openrouter.ai/api/v1").replace(/\/$/, "");
    this.fetcher = config.fetch ?? fetch;
  }

  static fromEnv(overrides: Partial<OpenRouterConfig> = {}): OpenRouterModelClient {
    return new OpenRouterModelClient({
      apiKey: overrides.apiKey ?? process.env.OPENROUTER_API_KEY ?? "",
      model: overrides.model ?? process.env.OPENROUTER_MODEL ?? "anthropic/claude-opus-4.6",
      baseUrl: overrides.baseUrl,
      appName: overrides.appName ?? process.env.OPENROUTER_APP_NAME ?? "42 Agent",
      httpReferer: overrides.httpReferer ?? process.env.OPENROUTER_HTTP_REFERER,
      fetch: overrides.fetch,
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
    while (true) {
      const { value, done } = await reader.read();
      buffer += value ?? "";
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (!data || data === "[DONE]") continue;
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
    return {
      model: this.model,
      messages: toOpenRouterMessages(request.messages, request.systemPrompt),
      tools: request.tools.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } })),
      stream,
    };
  }
}

function toOpenRouterMessages(messages: readonly Message[], systemPrompt: string): OpenRouterMessage[] {
  const converted: OpenRouterMessage[] = [{ role: "system", content: systemPrompt }];
  for (const message of messages) {
    if (message.role === "tool") {
      converted.push({ role: "tool", content: message.content, name: message.name, tool_call_id: message.toolCallId });
    } else if (message.role === "assistant") {
      const calls = (message.metadata?.toolCalls as ToolCall[] | undefined) ?? [];
      converted.push({
        role: "assistant", content: message.content || null,
        tool_calls: calls.length ? calls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) : undefined,
      });
    } else {
      converted.push({ role: message.role, content: message.content });
    }
  }
  return converted;
}

function parseToolCalls(calls: OpenRouterToolCall[]): ToolCall[] {
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
