import type { AgentLoopEvent } from "../runtime/events.js";
import type { TurnRequest } from "../service/runtime-http-server.js";

export type RuntimeStreamItem =
  | { type: "event"; event: AgentLoopEvent }
  | { type: "result"; content: string }
  | { type: "error"; message: string };

export async function* streamRuntimeTurn(
  baseUrl: string,
  request: TurnRequest,
  signal?: AbortSignal,
): AsyncIterable<RuntimeStreamItem> {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/turn`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
    signal,
  });
  if (!response.ok || !response.body) throw new Error(`Runtime request failed: ${response.status}`);
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    buffer += value ?? "";
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) if (line.trim()) yield JSON.parse(line) as RuntimeStreamItem;
    if (done) break;
  }
  if (buffer.trim()) yield JSON.parse(buffer) as RuntimeStreamItem;
}
