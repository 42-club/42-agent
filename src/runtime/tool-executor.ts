import type { ToolCall } from "../model.js";
import {
  createMessage,
  SessionSaveOutcomeUnknownError,
  type RunState,
  type SaveSessionOptions,
  type Session,
  type SessionStore,
} from "../session.js";
import type { ToolExecutionContext } from "../tools/base.js";
import { ToolRegistry } from "../tools/base.js";
import type { AgentLoopEvent, EventDispatcher } from "./events.js";
import { throwIfAborted } from "./retry.js";

type ToolOutcome =
  | { status: "completed"; result: unknown }
  | { status: "failed"; error: string }
  | { status: "interrupted"; error: string };

interface ScheduledCall {
  call: ToolCall;
  index: number;
  writesSession: boolean;
  exclusive: boolean;
}

type WorkerSettlement =
  | { scheduled: ScheduledCall; succeeded: true }
  | { scheduled: ScheduledCall; succeeded: false; error: unknown };

/** Per-Run mutation admission supplied privately by AgentLoop. */
interface RunMutationGate {
  readonly checkpoint: (mutate?: () => void, options?: SaveSessionOptions) => Promise<void>;
}

/**
 * Backwards-compatible direct executor facade.
 *
 * @deprecated Prefer AgentLoop, which owns mutation admission and supplies a
 * private per-Run gate to the coordinated executor.
 */
export class ToolExecutor {
  private persistenceTail: Promise<void> = Promise.resolve();
  private readonly outcomeUnknown = new WeakMap<Session, SessionSaveOutcomeUnknownError>();

  constructor(
    private readonly tools: ToolRegistry,
    private readonly sessions: SessionStore,
    private readonly events: EventDispatcher,
    private readonly maxConcurrency = 4,
  ) {}

  executeAll(
    calls: readonly ToolCall[],
    context: ToolExecutionContext,
    runState: RunState,
  ): Promise<void> {
    const gate: RunMutationGate = Object.freeze({
      checkpoint: (mutate?: () => void, options?: SaveSessionOptions) => this.checkpoint(
        context.session,
        mutate,
        options,
      ),
    });
    return new CoordinatedToolExecutor(
      this.tools,
      gate,
      this.events,
      this.maxConcurrency,
    ).executeAll(calls, context, runState);
  }

  private async checkpoint(
    session: Session,
    mutate?: () => void,
    options?: SaveSessionOptions,
  ): Promise<void> {
    const pending = this.persistenceTail.then(async () => {
      const outcomeUnknown = this.outcomeUnknown.get(session);
      if (outcomeUnknown) throw outcomeUnknown;
      mutate?.();
      await this.sessions.save(session, options);
    });
    this.persistenceTail = pending.then(
      () => undefined,
      (error: unknown) => {
        if (error instanceof SessionSaveOutcomeUnknownError
          && !this.outcomeUnknown.has(session)) {
          this.outcomeUnknown.set(session, error);
        }
        // A definite failure does not poison the compatibility facade; callers
        // may still reconcile the live Session in a later checkpoint.
      },
    );
    await pending;
  }
}

/** @internal AgentLoop is the only package component that constructs this class. */
export class CoordinatedToolExecutor {
  constructor(
    private readonly tools: ToolRegistry,
    private readonly mutationGate: RunMutationGate,
    private readonly events: EventDispatcher,
    private readonly maxConcurrency = 4,
  ) {}

  async executeAll(
    calls: readonly ToolCall[],
    context: ToolExecutionContext,
    runState: RunState,
  ): Promise<void> {
    this.assertUniqueCallIds(calls, runState);
    const rewritesMessages = calls.some((call) => this.isWriteTool(call.name));
    runState.phase = "tools";
    runState.toolCalls.push(...calls.map((call) => ({
      ...call,
      arguments: structuredClone(call.arguments),
      status: "pending" as const,
    })));
    await this.persist();

    const outcomes = new Map<string, ToolOutcome>();
    const pending: ScheduledCall[] = calls.map((call, index) => ({
      call,
      index,
      writesSession: this.isWriteTool(call.name),
      exclusive: this.isExclusiveTool(call.name),
    }));
    const active = new Map<number, Promise<WorkerSettlement>>();
    const concurrency = Math.max(1, Math.floor(this.maxConcurrency));
    let exclusiveActive = false;
    let stopDispatching = context.signal?.aborted ?? false;
    let workerFailed = false;
    let workerError: unknown;

    const onAbort = (): void => {
      stopDispatching = true;
    };
    context.signal?.addEventListener("abort", onAbort, { once: true });

    const startEligibleCalls = (): void => {
      while (!stopDispatching && !exclusiveActive && active.size < concurrency && pending.length > 0) {
        const scheduled = pending[0]!;
        // An exclusive tool is a barrier: wait for earlier parallel tools, run
        // alone, then admit later work. Session writers are always exclusive;
        // externally side-effecting tools may opt in without Session access.
        if (scheduled.exclusive && active.size > 0) return;
        pending.shift();
        if (scheduled.exclusive) exclusiveActive = true;
        const worker = this.executeOne(scheduled, context, runState, outcomes)
          .then<WorkerSettlement, WorkerSettlement>(
            () => ({ scheduled, succeeded: true }),
            (error: unknown) => ({ scheduled, succeeded: false, error }),
          );
        active.set(scheduled.index, worker);
        if (scheduled.exclusive) return;
      }
    };

    try {
      startEligibleCalls();
      while (active.size > 0) {
        const settlement = await Promise.race(active.values());
        active.delete(settlement.scheduled.index);
        if (settlement.scheduled.exclusive) exclusiveActive = false;
        if (!settlement.succeeded && !workerFailed) {
          workerFailed = true;
          workerError = settlement.error;
          stopDispatching = true;
        }
        if (context.signal?.aborted) stopDispatching = true;
        startEligibleCalls();
      }
    } finally {
      context.signal?.removeEventListener("abort", onAbort);
    }

    if (pending.length > 0) {
      const reason = context.signal?.aborted
        ? "Tool execution was cancelled before it started"
        : "Tool execution was interrupted before it started";
      await this.persist(() => {
        for (const { call } of pending) {
          const state = this.callState(runState, call.id);
          state.status = "interrupted";
          state.error = reason;
          outcomes.set(call.id, { status: "interrupted", error: reason });
        }
        runState.updatedAt = new Date().toISOString();
      });
    }

    // Materialize every terminal outcome only after all started workers have settled.
    // Iterating the model's call list makes the messages deterministic even when tools
    // completed in a different order.
    await this.persist(() => {
      for (const call of calls) {
        const outcome = outcomes.get(call.id);
        if (!outcome) continue;
        context.session.messages.push(createMessage({
          role: "tool",
          name: call.name,
          toolCallId: call.id,
          content: serializeOutcome(outcome),
        }));
      }
    }, rewritesMessages ? { rewriteMessages: true } : undefined);

    if (workerFailed) throw workerError;
    throwIfAborted(context.signal);
  }

  private async executeOne(
    scheduled: ScheduledCall,
    context: ToolExecutionContext,
    runState: RunState,
    outcomes: Map<string, ToolOutcome>,
  ): Promise<void> {
    const { call } = scheduled;
    throwIfAborted(context.signal);
    await this.persist(() => {
      const state = this.callState(runState, call.id);
      state.status = "running";
      runState.updatedAt = new Date().toISOString();
    });
    await this.emitSafely({
      type: "tool_call_started",
      sessionId: context.session.id,
      runId: runState.id,
      call,
    });

    let outcome: ToolOutcome;
    try {
      const tool = this.tools.get(call.name);
      const argumentsSnapshot = structuredClone(call.arguments);
      this.tools.validate(call.name, argumentsSnapshot);
      const result = await tool.execute(argumentsSnapshot, this.tools.contextFor(tool, context));
      outcome = { status: "completed", result: toJsonCompatible(result) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      outcome = context.signal?.aborted || isAbortError(error)
        ? { status: "interrupted", error: message }
        : { status: "failed", error: message };
    }

    await this.persist(() => {
      const state = this.callState(runState, call.id);
      state.status = outcome.status;
      if (outcome.status === "completed") {
        state.result = outcome.result;
      } else {
        state.error = outcome.error;
      }
      outcomes.set(call.id, outcome);
      runState.updatedAt = new Date().toISOString();
    }, scheduled.writesSession ? { rewriteMessages: true } : undefined);

    if (outcome.status === "completed") {
      await this.emitSafely({
        type: "tool_call_completed",
        sessionId: context.session.id,
        runId: runState.id,
        call,
        result: outcome.result,
      });
    } else {
      await this.emitSafely({
        type: "tool_call_failed",
        sessionId: context.session.id,
        runId: runState.id,
        call,
        error: outcome.error,
      });
    }
  }

  private assertUniqueCallIds(calls: readonly ToolCall[], runState: RunState): void {
    const seen = new Set(runState.toolCalls.map((call) => call.id));
    for (const call of calls) {
      if (seen.has(call.id)) throw new Error(`Duplicate tool call ID in run: ${call.id}`);
      seen.add(call.id);
    }
  }

  private isWriteTool(name: string): boolean {
    try {
      return this.tools.get(name).sessionAccess === "write";
    } catch {
      // Unknown tools are executed through the normal path so their failure becomes
      // a model-visible ToolExecutionError.
      return false;
    }
  }

  private isExclusiveTool(name: string): boolean {
    try {
      return this.tools.effectiveExecutionPolicy(this.tools.get(name)) === "exclusive";
    } catch {
      return false;
    }
  }

  private callState(runState: RunState, callId: string) {
    const state = runState.toolCalls.find((candidate) => candidate.id === callId);
    if (!state) throw new Error(`Missing tool call state: ${callId}`);
    return state;
  }

  private async persist(
    mutate?: () => void,
    options?: SaveSessionOptions,
  ): Promise<void> {
    await this.mutationGate.checkpoint(mutate, options);
  }

  private async emitSafely(event: AgentLoopEvent): Promise<void> {
    try {
      await this.events.emit(event);
    } catch {
      // Event handlers are observers. Their availability must not rewrite a durable
      // tool success as a failure or cause a side-effecting tool to be replayed.
    }
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function serializeOutcome(outcome: ToolOutcome): string {
  const result = outcome.status === "completed"
    ? outcome.result
    : outcome.status === "failed"
      ? { error: "ToolExecutionError", message: outcome.error }
      : { error: "InterruptedToolCall", message: outcome.error };
  return JSON.stringify(result) ?? "null";
}

function toJsonCompatible(result: unknown): unknown {
  const serialized = JSON.stringify(result);
  return serialized === undefined ? null : JSON.parse(serialized);
}
