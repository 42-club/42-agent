import type {
  DeepReadonly,
  Message,
  RunState,
  Session,
} from "../session.js";

export interface RecoveryResult {
  recovered: boolean;
  interruptedToolCalls: number;
}

export interface RunRecoverySnapshot {
  session?: DeepReadonly<Session>;
  now: string;
}

export type RunRecoveryPlan =
  | {
      kind: "noop";
      result: RecoveryResult;
    }
  | {
      kind: "recover";
      expectedRunId: string;
      nextRunState: RunState;
      appendMessages: readonly Message[];
      result: RecoveryResult;
    };

export interface ToolCallReconciliationPlan {
  nextRunState: RunState;
  appendMessages: readonly Message[];
  interruptedToolCalls: number;
}

/**
 * Pure recovery policy. It inspects a detached Session snapshot and describes
 * the mutation that AgentLoop must checkpoint; it never owns live state.
 */
export class RunRecovery {
  plan(snapshot: DeepReadonly<RunRecoverySnapshot>): RunRecoveryPlan {
    const state = snapshot.session?.runState;
    if (!snapshot.session || !state || state.status !== "running") {
      return {
        kind: "noop",
        result: { recovered: false, interruptedToolCalls: 0 },
      };
    }

    const reconciliation = reconcileToolCallSnapshot(
      snapshot.session.messages,
      state,
      snapshot.now,
    );
    reconciliation.nextRunState.status = "interrupted";
    reconciliation.nextRunState.phase = "idle";
    reconciliation.nextRunState.updatedAt = snapshot.now;

    return {
      kind: "recover",
      expectedRunId: state.id,
      nextRunState: reconciliation.nextRunState,
      appendMessages: reconciliation.appendMessages,
      result: {
        recovered: true,
        interruptedToolCalls: reconciliation.interruptedToolCalls,
      },
    };
  }
}

/** Shared pure protocol repair used by recovery and terminal finalization. */
export function reconcileToolCallSnapshot(
  messages: readonly DeepReadonly<Message>[],
  state: DeepReadonly<RunState>,
  now: string,
): ToolCallReconciliationPlan {
  const nextRunState = structuredClone(state) as RunState;
  const runToolCallIds = new Set(state.toolCalls.map((call) => call.id));
  const batchStartByCall = new Map<string, number>();
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    if (message.role !== "assistant" || !Array.isArray(message.metadata?.toolCalls)) continue;
    for (const item of message.metadata.toolCalls) {
      if (typeof item !== "object" || item === null) continue;
      const callId = String((item as { readonly id?: unknown }).id);
      if (runToolCallIds.has(callId)) batchStartByCall.set(callId, index);
    }
  }

  const recordedToolCalls = new Set<string>();
  for (const call of state.toolCalls) {
    const batchStart = batchStartByCall.get(call.id);
    if (batchStart === undefined) continue;
    for (let index = batchStart + 1; index < messages.length; index += 1) {
      const message = messages[index]!;
      if (message.role === "assistant") break;
      if (message.role === "tool" && message.toolCallId === call.id) {
        recordedToolCalls.add(call.id);
        break;
      }
    }
  }

  const appendMessages: Message[] = [];
  let interruptedToolCalls = 0;
  for (const call of nextRunState.toolCalls) {
    let result: unknown;
    if (call.status === "completed") {
      result = call.result;
    } else if (call.status === "failed") {
      result = { error: "ToolExecutionError", message: call.error ?? "Tool execution failed" };
    } else {
      if (call.status === "running" || call.status === "pending") {
        call.status = "interrupted";
        call.error = "Execution interrupted before a durable result was recorded";
        interruptedToolCalls += 1;
      }
      result = {
        error: "InterruptedToolCall",
        message: "工具执行状态未知，未自动重试，需由后续运行重新判断。",
      };
    }
    if (recordedToolCalls.has(call.id) || !batchStartByCall.has(call.id)) continue;
    appendMessages.push({
      role: "tool",
      name: call.name,
      toolCallId: call.id,
      content: serializeToolResult(result),
      createdAt: now,
    });
    recordedToolCalls.add(call.id);
  }

  return { nextRunState, appendMessages, interruptedToolCalls };
}

function serializeToolResult(result: unknown): string {
  return JSON.stringify(result) ?? "null";
}
