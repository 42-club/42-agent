import type { AgentLoopEvent } from "../runtime/events.js";
import type { RuntimeStopReason } from "../agent-runtime.js";
import type { TurnRequest } from "./runtime-http-server.js";

export type RuntimeStreamItem =
  | { type: "event"; event: AgentLoopEvent }
  | {
    type: "result";
    sessionId: string;
    runId: string;
    stopReason: RuntimeStopReason;
    content: string;
  }
  | { type: "error"; code: string; message: string };

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
  if (!response.ok) {
    yield await readRuntimeHttpError(response);
    return;
  }
  if (!response.body) {
    throw new Error(`Runtime response body is missing: ${response.status}`);
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

async function readRuntimeHttpError(response: Response): Promise<RuntimeStreamItem> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch (cause) {
    throw new Error(`Runtime request failed: ${response.status}`, { cause });
  }
  if (!isRecord(payload)
    || payload.type !== "error"
    || typeof payload.code !== "string"
    || typeof payload.message !== "string") {
    throw new Error(`Runtime request failed: ${response.status}`);
  }
  return { type: "error", code: payload.code, message: payload.message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
