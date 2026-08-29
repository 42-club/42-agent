import type { ModelRequest, ToolCall } from "../model.js";
import type { Message } from "../session.js";

export interface OpenAiCompatibleToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface OpenAiCompatibleMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: OpenAiCompatibleToolCall[];
}

export function toOpenAiCompatiblePayload(
  model: string,
  request: ModelRequest,
  stream: boolean,
): Record<string, unknown> {
  return {
    model,
    messages: toOpenAiCompatibleMessages(request.messages, request.systemPrompt),
    tools: request.tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    })),
    stream,
  };
}

export function toOpenAiCompatibleMessages(
  messages: readonly Message[],
  systemPrompt: string,
): OpenAiCompatibleMessage[] {
  const converted: OpenAiCompatibleMessage[] = [{ role: "system", content: systemPrompt }];
  for (const message of messages) {
    if (message.role === "tool") {
      converted.push({
        role: "tool",
        content: message.content,
        name: message.name,
        tool_call_id: message.toolCallId,
      });
    } else if (message.role === "assistant") {
      const calls = (message.metadata?.toolCalls as ToolCall[] | undefined) ?? [];
      converted.push({
        role: "assistant",
        content: message.content || null,
        tool_calls: calls.length
          ? calls.map((call) => ({
              id: call.id,
              type: "function",
              function: { name: call.name, arguments: JSON.stringify(call.arguments) },
            }))
          : undefined,
      });
    } else {
      converted.push({ role: message.role, content: message.content });
    }
  }
  return converted;
}
