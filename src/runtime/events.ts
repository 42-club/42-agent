import type { ToolCall } from "../model.js";
import type { RuntimeErrorInfo } from "./errors.js";

export type AgentLoopEvent =
  | { type: "run_started"; sessionId: string; runId: string }
  | { type: "model_started"; sessionId: string; runId: string; round: number }
  | { type: "model_retry"; sessionId: string; runId: string; attempt: number; maxAttempts: number; delayMs: number; error: RuntimeErrorInfo }
  | { type: "text_delta"; sessionId: string; runId: string; delta: string }
  | { type: "tool_call_started"; sessionId: string; runId: string; call: ToolCall }
  | { type: "tool_call_completed"; sessionId: string; runId: string; call: ToolCall; result: unknown }
  | { type: "tool_call_failed"; sessionId: string; runId: string; call: ToolCall; error: string }
  | { type: "steering_applied"; sessionId: string; runId: string; count: number }
  | { type: "run_completed"; sessionId: string; runId: string; content: string }
  | { type: "run_failed"; sessionId: string; runId: string; error: RuntimeErrorInfo }
  | { type: "run_cancelled"; sessionId: string; runId: string };

export type AgentLoopEventHandler = (event: AgentLoopEvent) => void | Promise<void>;

export class EventDispatcher {
  constructor(private readonly handler?: AgentLoopEventHandler) {}

  emit(event: AgentLoopEvent): void {
    if (!this.handler) return;
    let snapshot: AgentLoopEvent;
    try {
      snapshot = deepFreeze(structuredClone(event));
    } catch {
      // Projection data must never become part of the canonical state machine.
      return;
    }
    try {
      void Promise.resolve(this.handler(snapshot)).catch(() => undefined);
    } catch {
      // Observers are detached, best-effort projections.
    }
  }
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    deepFreeze((value as Record<PropertyKey, unknown>)[key], seen);
  }
  return Object.freeze(value);
}
