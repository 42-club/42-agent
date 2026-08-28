import type { AgentLoopEvent } from "../runtime/events.js";
import type { RuntimeStopReason } from "../agent-runtime.js";
import type { TurnRequest } from "../service/runtime-http-server.js";

export type RuntimeStreamItem =
  | { type: "event"; event: AgentLoopEvent }
  | {
    type: "result";
    sessionId: string;
    runId: string;
    stopReason: RuntimeStopReason;
    content: string;
  }
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
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`Runtime request failed: ${response.status}`);
  }
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  let completed = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += value ?? "";
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) yield JSON.parse(line) as RuntimeStreamItem;
      if (done) {
        completed = true;
        break;
      }
    }
    if (buffer.trim()) yield JSON.parse(buffer) as RuntimeStreamItem;
  } finally {
    if (!completed) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
