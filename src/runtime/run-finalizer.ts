import type { RuntimeErrorInfo } from "./errors.js";
import type { AgentLoopEvent } from "./events.js";
import type {
  DeepReadonly,
  Message,
  RunState,
  SaveSessionOptions,
} from "../session.js";
import {
  reconcileToolCallSnapshot,
  type RunPolicySessionSnapshot,
} from "./run-recovery.js";

interface RunFinalizationBaseSnapshot {
  session: DeepReadonly<RunPolicySessionSnapshot>;
  now: string;
}

export type RunFinalizationSnapshot =
  | (RunFinalizationBaseSnapshot & {
      kind: "completed";
      content: string;
    })
  | (RunFinalizationBaseSnapshot & {
      kind: "failed";
      cancelled: boolean;
      errorMessage: string;
      error: DeepReadonly<RuntimeErrorInfo>;
    });

export interface RunFinalizationPlan {
  expectedRunId: string;
  nextRunState: RunState;
  appendMessages: readonly Message[];
  saveOptions?: SaveSessionOptions;
  event: Extract<
    AgentLoopEvent,
    { type: "run_completed" | "run_failed" | "run_cancelled" }
  >;
}

/** Pure terminal policy; AgentLoop applies and checkpoints the returned plan. */
export class RunFinalizer {
  plan(snapshot: DeepReadonly<RunFinalizationSnapshot>): RunFinalizationPlan {
    const state = snapshot.session.runState;
    if (!state) throw new Error("Cannot finalize a Session without an active Run");

    if (snapshot.kind === "completed") {
      const nextRunState = structuredClone(state) as RunState;
      nextRunState.status = "completed";
      nextRunState.phase = "idle";
      nextRunState.updatedAt = snapshot.now;
      return {
        expectedRunId: state.id,
        nextRunState,
        appendMessages: [],
        event: {
          type: "run_completed",
          sessionId: snapshot.session.id,
          runId: state.id,
          content: snapshot.content,
        },
      };
    }

    const reconciliation = reconcileToolCallSnapshot(
      snapshot.session.messages,
      state,
      snapshot.now,
    );
    reconciliation.nextRunState.status = snapshot.cancelled ? "cancelled" : "failed";
    reconciliation.nextRunState.phase = "idle";
    reconciliation.nextRunState.error = snapshot.errorMessage;
    reconciliation.nextRunState.updatedAt = snapshot.now;

    return {
      expectedRunId: state.id,
      nextRunState: reconciliation.nextRunState,
      appendMessages: reconciliation.appendMessages,
      saveOptions: { rewriteMessages: true },
      event: snapshot.cancelled
        ? {
            type: "run_cancelled",
            sessionId: snapshot.session.id,
            runId: state.id,
          }
        : {
            type: "run_failed",
            sessionId: snapshot.session.id,
            runId: state.id,
            error: structuredClone(snapshot.error) as RuntimeErrorInfo,
          },
    };
  }
}
