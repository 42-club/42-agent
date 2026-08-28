import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import {
  methods,
  RequestError,
  type AgentContext,
  type RequestPermissionRequest,
} from "@agentclientprotocol/sdk";
import type { AgentLoopEvent } from "../runtime/events.js";
import type { ApprovalHandler } from "../tools/base.js";

interface PermissionContext {
  readonly client: AgentContext;
  readonly sessionId: string;
  readonly signal: AbortSignal;
  readonly activeToolCalls: Map<string, {
    readonly id: string;
    readonly name: string;
    readonly arguments: Record<string, unknown>;
  }>;
}

export interface AcpPermissionScope {
  client: AgentContext;
  sessionId: string;
  signal: AbortSignal;
}

export interface AcpPermissionBridgeOptions {
  /** Secure default for prompts that do not originate from an ACP connection. */
  fallback?: ApprovalHandler;
}

/**
 * Routes the Runtime's protocol-neutral boolean approval hook to the ACP client
 * handling the current prompt. Pass `requestApproval` to `AgentLoop`, then pass
 * the bridge itself to `createAcpAgent`.
 */
export class AcpPermissionBridge {
  private readonly contexts = new AsyncLocalStorage<PermissionContext>();
  private readonly fallback: ApprovalHandler;

  readonly requestApproval: ApprovalHandler = (question, signal) => this.request(question, signal);

  constructor(options: AcpPermissionBridgeOptions = {}) {
    this.fallback = options.fallback ?? (async () => false);
  }

  run<T>(scope: AcpPermissionScope, operation: () => Promise<T>): Promise<T> {
    return this.contexts.run({
      ...scope,
      activeToolCalls: new Map(),
    }, operation);
  }

  /** @internal Tracks the best available runtime tool identity for permission UI. */
  observe(event: AgentLoopEvent): void {
    const context = this.contexts.getStore();
    if (!context || event.sessionId !== context.sessionId) return;
    if (event.type === "tool_call_started") {
      context.activeToolCalls.set(event.call.id, {
        id: event.call.id,
        name: event.call.name,
        arguments: structuredClone(event.call.arguments),
      });
    } else if (event.type === "tool_call_completed" || event.type === "tool_call_failed") {
      context.activeToolCalls.delete(event.call.id);
    }
  }

  private async request(question: string, turnSignal?: AbortSignal): Promise<boolean> {
    const context = this.contexts.getStore();
    if (!context) return this.fallback(question, turnSignal);
    const signal = turnSignal
      ? AbortSignal.any([context.signal, turnSignal])
      : context.signal;
    if (signal.aborted) return false;

    // ApprovalHandler intentionally exposes no tool identity. When exactly one
    // tool is active we can correlate it; parallel approvals get an isolated ID
    // rather than being attributed to the wrong tool.
    const active = [...context.activeToolCalls.values()];
    const call = active.length === 1 ? active[0] : undefined;
    const allowId = `allow-once:${randomUUID()}`;
    const rejectId = `reject-once:${randomUUID()}`;
    const request: RequestPermissionRequest = {
      sessionId: context.sessionId,
      toolCall: {
        toolCallId: call?.id ?? `approval:${randomUUID()}`,
        title: question,
        kind: toolKind(call?.name),
        status: "pending",
        ...(call ? { rawInput: structuredClone(call.arguments) } : {}),
      },
      options: [
        { optionId: allowId, name: "Allow once", kind: "allow_once" },
        { optionId: rejectId, name: "Reject", kind: "reject_once" },
      ],
    };

    const response = context.client.request(
      methods.client.session.requestPermission,
      request,
      { cancellationSignal: signal },
    );
    try {
      const selected = await settleUntilAbort(response, signal);
      if (!selected || selected.outcome.outcome === "cancelled") return false;
      if (selected.outcome.optionId === allowId) return true;
      if (selected.outcome.optionId === rejectId) return false;
      throw RequestError.invalidParams(
        { optionId: selected.outcome.optionId },
        "permission response selected an unknown option",
      );
    } catch (error) {
      if (signal.aborted || isCancellation(error)) return false;
      throw error;
    }
  }
}

function toolKind(name: string | undefined): RequestPermissionRequest["toolCall"]["kind"] {
  const normalized = name?.toLowerCase() ?? "";
  if (/delete|remove|unlink/.test(normalized)) return "delete";
  if (/write|edit|update|patch|replace/.test(normalized)) return "edit";
  if (/read|load|open/.test(normalized)) return "read";
  if (/search|find|query/.test(normalized)) return "search";
  if (/bash|shell|exec|run|command/.test(normalized)) return "execute";
  if (/fetch|http|download/.test(normalized)) return "fetch";
  return "other";
}

async function settleUntilAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
  if (signal.aborted) {
    void pending.catch(() => undefined);
    return undefined;
  }
  let detach = (): void => undefined;
  const aborted = new Promise<undefined>((resolve) => {
    const listener = (): void => resolve(undefined);
    signal.addEventListener("abort", listener, { once: true });
    detach = () => signal.removeEventListener("abort", listener);
  });
  try {
    const result = await Promise.race([pending, aborted]);
    if (result === undefined) void pending.catch(() => undefined);
    return result;
  } finally {
    detach();
  }
}

function isCancellation(error: unknown): boolean {
  return error instanceof RequestError && error.code === -32800
    || error instanceof Error && error.name === "AbortError";
}
