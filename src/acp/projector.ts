import {
  methods,
  type AgentContext,
  type SessionUpdate,
  type ToolKind,
} from "@agentclientprotocol/sdk";
import type { AgentLoopEvent } from "../runtime/events.js";

export interface AcpUpdateProjectorOptions {
  sessionId: string;
  client: AgentContext;
  maxPendingUpdates: number;
  signal: AbortSignal;
  deliveryTimeoutMs: number;
  onFailure: (error: Error) => void;
}

/** Ordered, bounded projection from detached Runtime events to ACP updates. */
export class AcpUpdateProjector {
  private readonly sessionId: string;
  private readonly client: AgentContext;
  private readonly maxPendingUpdates: number;
  private readonly signal: AbortSignal;
  private readonly deliveryTimeoutMs: number;
  private readonly onFailure: (error: Error) => void;
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;
  private failureValue: Error | undefined;
  private messageId: string | undefined;
  private currentRoundText = "";

  constructor(options: AcpUpdateProjectorOptions) {
    this.sessionId = options.sessionId;
    this.client = options.client;
    this.maxPendingUpdates = options.maxPendingUpdates;
    this.signal = options.signal;
    this.deliveryTimeoutMs = options.deliveryTimeoutMs;
    this.onFailure = options.onFailure;
  }

  get failure(): Error | undefined {
    return this.failureValue;
  }

  observe(event: AgentLoopEvent): void {
    switch (event.type) {
      case "model_started":
        this.messageId = `${event.runId}:${event.round}`;
        this.currentRoundText = "";
        break;
      case "text_delta":
        this.currentRoundText += event.delta;
        this.enqueue({
          sessionUpdate: "agent_message_chunk",
          messageId: this.messageId ?? event.runId,
          content: { type: "text", text: event.delta },
        });
        break;
      case "tool_call_started":
        this.enqueue({
          sessionUpdate: "tool_call",
          toolCallId: event.call.id,
          title: event.call.name,
          kind: inferToolKind(event.call.name),
          status: "in_progress",
          rawInput: event.call.arguments,
        });
        break;
      case "tool_call_completed":
        this.enqueue({
          sessionUpdate: "tool_call_update",
          toolCallId: event.call.id,
          status: "completed",
          rawOutput: event.result,
          content: [{
            type: "content",
            content: { type: "text", text: displayValue(event.result) },
          }],
        });
        break;
      case "tool_call_failed":
        this.enqueue({
          sessionUpdate: "tool_call_update",
          toolCallId: event.call.id,
          status: "failed",
          rawOutput: { error: event.error },
          content: [{
            type: "content",
            content: { type: "text", text: event.error },
          }],
        });
        break;
      default:
        break;
    }
  }

  ensureFinalText(text: string, runId: string): void {
    if (this.currentRoundText === text) return;
    if (text.startsWith(this.currentRoundText)) {
      const suffix = text.slice(this.currentRoundText.length);
      if (suffix.length === 0) return;
      this.enqueue({
        sessionUpdate: "agent_message_chunk",
        messageId: this.messageId ?? runId,
        content: { type: "text", text: suffix },
      });
      this.currentRoundText = text;
      return;
    }
    // ACP v1 has no message-replacement primitive. If a provider's terminal
    // response diverges from already emitted deltas, publish the canonical
    // Runtime result as a distinct message instead of silently leaving the
    // client on a draft that is absent from canonical history.
    this.enqueue({
      sessionUpdate: "agent_message_chunk",
      messageId: `${runId}:final`,
      content: { type: "text", text },
    });
    this.currentRoundText = text;
  }

  async drain(): Promise<void> {
    await this.tail;
    if (this.failureValue) throw this.failureValue;
  }

  private enqueue(update: SessionUpdate): void {
    if (this.failureValue || this.signal.aborted) return;
    if (this.pending >= this.maxPendingUpdates) {
      this.fail(new AcpUpdateBackpressureError(this.maxPendingUpdates));
      return;
    }
    this.pending += 1;
    this.tail = this.tail
      .then(() => deliverWithBounds(
        () => this.client.notify(methods.client.session.update, {
          sessionId: this.sessionId,
          update,
        }),
        this.signal,
        this.deliveryTimeoutMs,
      ))
      .catch((error: unknown) => this.fail(asError(error)))
      .finally(() => {
        this.pending -= 1;
      });
  }

  private fail(error: Error): void {
    if (this.failureValue) return;
    this.failureValue = error;
    this.onFailure(error);
  }
}

export class AcpUpdateBackpressureError extends Error {
  constructor(limit: number) {
    super(`ACP session update queue exceeded its limit of ${limit}`);
    this.name = "AcpUpdateBackpressureError";
  }
}

export class AcpUpdateDeliveryTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`ACP session update delivery exceeded ${timeoutMs}ms`);
    this.name = "AcpUpdateDeliveryTimeoutError";
  }
}

function inferToolKind(name: string): ToolKind {
  const normalized = name.toLowerCase();
  if (/delete|remove|unlink/.test(normalized)) return "delete";
  if (/write|edit|update|patch|replace/.test(normalized)) return "edit";
  if (/read|load|open/.test(normalized)) return "read";
  if (/search|find|query/.test(normalized)) return "search";
  if (/bash|shell|exec|run|command/.test(normalized)) return "execute";
  if (/fetch|http|download/.test(normalized)) return "fetch";
  return "other";
}

function displayValue(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value) ?? "null";
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

async function deliverWithBounds(
  deliver: () => Promise<void>,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<void> {
  // Check before invoking the transport. Queued updates behind a hung delivery
  // must not be sent after cancellation.
  if (signal.aborted) return;
  const delivery = deliver();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let detach = (): void => undefined;
  const cancelled = new Promise<"cancelled">((resolve) => {
    const listener = (): void => resolve("cancelled");
    signal.addEventListener("abort", listener, { once: true });
    detach = () => signal.removeEventListener("abort", listener);
    // `deliver()` may synchronously trigger cancellation before the listener is
    // installed. AbortSignal does not replay past events.
    if (signal.aborted) listener();
  });
  const timedOut = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new AcpUpdateDeliveryTimeoutError(timeoutMs)), timeoutMs);
  });
  const observedDelivery = delivery.then(() => "delivered" as const);
  // If timeout/cancellation wins, retain a rejection observer for a transport
  // promise that settles later.
  void observedDelivery.catch(() => undefined);
  try {
    await Promise.race([observedDelivery, cancelled, timedOut]);
  } finally {
    if (timer) clearTimeout(timer);
    detach();
  }
}
