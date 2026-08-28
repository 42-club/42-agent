import { randomUUID } from "node:crypto";
import { estimateTokens, type ModelClient, type ToolCall } from "./model.js";
import { buildSystemPrompt } from "./prompt.js";
import {
  EventDispatcher,
  type AgentLoopEvent,
  type AgentLoopEventHandler,
} from "./runtime/events.js";
import { ModelRunner } from "./runtime/model-runner.js";
import { RetryPolicy, type RetryPolicyOptions, throwIfAborted } from "./runtime/retry.js";
import { normalizeRuntimeError } from "./runtime/errors.js";
import { SteeringQueue } from "./runtime/steering.js";
import { ToolExecutor } from "./runtime/tool-executor.js";
import { createMessage, type RunState, type Session, type SessionStore } from "./session.js";
import type { SkillLoader } from "./skills.js";
import type { ApprovalHandler } from "./tools/base.js";
import { ToolRegistry } from "./tools/base.js";

export interface AgentLoopConfig {
  compressionThreshold?: number;
  compressionThresholdTokens?: number;
  maxToolRounds?: number;
  retry?: RetryPolicyOptions;
}

export interface RunTurnInput {
  sessionId: string;
  userInput: string;
  promptInjections?: readonly string[];
  skills?: readonly string[];
  tools?: readonly string[];
  signal?: AbortSignal;
  onEvent?: AgentLoopEventHandler;
}

export interface TurnExecutionResult {
  sessionId: string;
  runId: string;
  content: string;
  stopReason: "end_turn";
}

export interface RecoveryResult {
  recovered: boolean;
  interruptedToolCalls: number;
}

export class AgentLoop {
  private readonly compressionThreshold: number;
  private readonly compressionThresholdTokens: number;
  private readonly maxToolRounds: number;
  private readonly retry: RetryPolicy;
  private readonly steering = new SteeringQueue();
  private readonly sessionTails = new Map<string, Promise<void>>();

  constructor(
    private readonly dependencies: {
      model: ModelClient;
      sessionStore: SessionStore;
      tools: ToolRegistry;
      requestApproval: ApprovalHandler;
      skillLoader?: SkillLoader;
      onEvent?: AgentLoopEventHandler;
      config?: AgentLoopConfig;
    },
  ) {
    this.compressionThreshold = dependencies.config?.compressionThreshold ?? 100;
    const contextWindow = dependencies.model.capabilities?.contextWindowTokens ?? 128_000;
    this.compressionThresholdTokens = dependencies.config?.compressionThresholdTokens ?? Math.floor(contextWindow * 0.65);
    this.maxToolRounds = dependencies.config?.maxToolRounds ?? 16;
    this.retry = new RetryPolicy(dependencies.config?.retry);
  }

  /** Canonical store used by every operation coordinated by this loop. */
  get sessionStore(): SessionStore {
    return this.dependencies.sessionStore;
  }

  /** Canonical registry used for validation, model exposure, and execution. */
  get toolRegistry(): ToolRegistry {
    return this.dependencies.tools;
  }

  /** Canonical Skill loader used to build prompts, when configured. */
  get skillLoader(): SkillLoader | undefined {
    return this.dependencies.skillLoader;
  }

  steer(sessionId: string, message: string): boolean {
    return this.steering.enqueue(sessionId, message);
  }

  clearSteering(sessionId: string): void {
    this.steering.clear(sessionId);
  }

  async recoverSession(sessionId: string): Promise<RecoveryResult> {
    return this.enqueueSession(sessionId, () => this.recoverSessionSerialized(sessionId));
  }

  private async recoverSessionSerialized(sessionId: string): Promise<RecoveryResult> {
    const session = await this.dependencies.sessionStore.get(sessionId);
    if (!session) return { recovered: false, interruptedToolCalls: 0 };
    const state = session.runState;
    if (!state || state.status !== "running") {
      return { recovered: false, interruptedToolCalls: 0 };
    }

    const interruptedToolCalls = reconcileToolCallMessages(session, state);
    state.status = "interrupted";
    state.phase = "idle";
    state.updatedAt = new Date().toISOString();
    await this.dependencies.sessionStore.save(session);
    return { recovered: true, interruptedToolCalls };
  }

  async runTurn(input: RunTurnInput): Promise<string> {
    return (await this.runTurnDetailed(input)).content;
  }

  async runTurnDetailed(input: RunTurnInput): Promise<TurnExecutionResult> {
    const request = snapshotRunTurnInput(input);
    return this.enqueueSession(request.sessionId, () => this.runTurnSerialized(request));
  }

  private async runTurnSerialized(input: RunTurnInput): Promise<TurnExecutionResult> {
    // A request cancelled before admission (including while waiting in the
    // per-session FIFO) must not create a Run or append a user message.
    throwIfAborted(input.signal);
    // Capability resolution is admission validation and must not mutate or
    // recover a Session when the requested scope itself is invalid.
    const activeTools: ToolRegistry = input.tools
      ? this.dependencies.tools.select(input.tools)
      : this.dependencies.tools;
    await this.recoverSessionSerialized(input.sessionId);
    const session = await this.dependencies.sessionStore.getOrCreate(input.sessionId);
    const runState = createRunState();
    session.runState = runState;
    session.messages.push(createMessage({ role: "user", content: input.userInput }));
    const events = new EventDispatcher((event) => {
      // Observers report state; they do not participate in the state machine.
      // A disconnected transport must never turn a completed run into a failed
      // run (or leave a just-started run permanently marked as running).
      // The per-Turn hook carries AgentRuntime's trusted lifecycle bookkeeping;
      // update it before exposing terminal events to a Loop-level observer.
      notifyObserver(input.onEvent, event);
      notifyObserver(this.dependencies.onEvent, event);
    });
    const modelRunner = new ModelRunner(this.dependencies.model, this.retry);
    const toolExecutor = new ToolExecutor(
      activeTools,
      this.dependencies.sessionStore,
      events,
    );
    const toolContext = {
      session,
      requestApproval: this.dependencies.requestApproval,
      signal: input.signal,
    };

    await this.dependencies.sessionStore.save(session);
    this.steering.begin(session.id, runState.id);
    await events.emit({ type: "run_started", sessionId: session.id, runId: runState.id });

    try {
      throwIfAborted(input.signal);
      const estimatedHistoryTokens = session.messages.reduce((sum, message) => sum + estimateTokens(message.content) + 4, 0);
      // compressionThreshold remains as a backwards-compatible explicit override.
      const shouldCompress = estimatedHistoryTokens >= this.compressionThresholdTokens
        || (this.dependencies.config?.compressionThreshold !== undefined
          && session.messages.length >= this.compressionThreshold);
      if (shouldCompress && activeTools.has("compress_conversation")) {
        const compression = activeTools.get("compress_conversation");
        activeTools.validate(compression.name, {});
        const result = await compression.execute(
          {},
          activeTools.contextFor(compression, toolContext),
        ) as { compressed?: boolean };
        await this.dependencies.sessionStore.save(session, {
          rewriteMessages: result.compressed === true,
        });
      }

      const systemPrompt = await this.resolveSystemPrompt(input);
      for (let round = 0; round < this.maxToolRounds; round += 1) {
        throwIfAborted(input.signal);
        runState.round = round;
        runState.phase = "model";
        touch(runState);
        await this.dependencies.sessionStore.save(session);
        await events.emit({
          type: "model_started",
          sessionId: session.id,
          runId: runState.id,
          round,
        });

        const response = await modelRunner.run(
          {
            messages: immutableSnapshot(session.messages),
            tools: immutableSnapshot(activeTools.definitions()),
            systemPrompt,
            signal: input.signal,
          },
          {
            onTextDelta: (delta) =>
              events.emit({
                type: "text_delta",
                sessionId: session.id,
                runId: runState.id,
                delta,
              }),
            onRetry: (attempt) => events.emit({
              type: "model_retry", sessionId: session.id, runId: runState.id, ...attempt,
            }),
          },
        );
        // A provider can settle in the same task in which a client cancels.
        // Re-check before admitting its response into canonical history.
        throwIfAborted(input.signal);
        const calls = normalizeToolCalls(response.toolCalls);
        const content = normalizeModelContent(response.content);
        assertUniqueToolCallIds(calls, runState);
        session.messages.push(
          createMessage({
            role: "assistant",
            content,
            metadata: calls.length ? { toolCalls: structuredClone(calls) } : undefined,
          }),
        );

        if (calls.length > 0) {
          await toolExecutor.executeAll(calls, toolContext, runState);
          await this.applySteering(session, runState, events);
          continue;
        }

        const steeringCount = await this.applySteering(session, runState, events, true);
        if (steeringCount > 0) continue;
        throwIfAborted(input.signal);

        runState.status = "completed";
        runState.phase = "idle";
        touch(runState);
        await this.dependencies.sessionStore.save(session);
        await events.emit({
          type: "run_completed",
          sessionId: session.id,
          runId: runState.id,
          content,
        });
        return {
          sessionId: session.id,
          runId: runState.id,
          content,
          stopReason: "end_turn",
        };
      }
      throw new Error("Agent exceeded maximum tool rounds");
    } catch (error) {
      this.steering.end(session.id, runState.id);
      const cancelled = input.signal?.aborted || isAbortError(error);
      // A checkpoint can fail after the assistant tool-call message or a live
      // call-state mutation. Always close that protocol batch before persisting
      // the terminal Run so the next model request never sees orphaned calls.
      reconcileToolCallMessages(session, runState);
      runState.status = cancelled ? "cancelled" : "failed";
      runState.phase = "idle";
      runState.error = error instanceof Error ? error.message : String(error);
      touch(runState);
      await this.dependencies.sessionStore.save(session, { rewriteMessages: true });
      if (cancelled) {
        await events.emit({ type: "run_cancelled", sessionId: session.id, runId: runState.id });
      } else {
        await events.emit({
          type: "run_failed",
          sessionId: session.id,
          runId: runState.id,
          error: normalizeRuntimeError(error),
        });
      }
      throw error;
    }
  }

  private async enqueueSession<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.sessionTails.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.catch(() => undefined).then(() => current);
    this.sessionTails.set(sessionId, tail);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.sessionTails.get(sessionId) === tail) this.sessionTails.delete(sessionId);
    }
  }

  private async resolveSystemPrompt(input: RunTurnInput): Promise<string> {
    const skillPrompts: string[] = [];
    if (input.skills?.length) {
      if (!this.dependencies.skillLoader) throw new Error("No SkillLoader configured");
      const loaded = await this.dependencies.skillLoader.load(input.skills);
      skillPrompts.push(...loaded.map((skill) => skill.instructions));
    }
    return buildSystemPrompt([...(input.promptInjections ?? []), ...skillPrompts]);
  }

  private async applySteering(
    session: Session,
    runState: RunState,
    events: EventDispatcher,
    finalBarrier = false,
  ): Promise<number> {
    // On the terminal barrier, observing an empty queue and closing admission
    // are one synchronous operation. A steer() that returns true therefore
    // always belongs to this Turn and can never leak into the next one.
    const messages = finalBarrier
      ? this.steering.drainFinal(session.id, runState.id)
      : this.steering.drain(session.id, runState.id);
    for (const message of messages) {
      session.messages.push(
        createMessage({ role: "user", content: message, metadata: { kind: "steering" } }),
      );
    }
    if (messages.length > 0) {
      touch(runState);
      await this.dependencies.sessionStore.save(session);
      await events.emit({
        type: "steering_applied",
        sessionId: session.id,
        runId: runState.id,
        count: messages.length,
      });
    }
    return messages.length;
  }
}

function createRunState(): RunState {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    status: "running",
    round: 0,
    phase: "idle",
    startedAt: now,
    updatedAt: now,
    toolCalls: [],
  };
}

function touch(state: RunState): void {
  state.updatedAt = new Date().toISOString();
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function serializeToolResult(result: unknown): string {
  return JSON.stringify(result) ?? "null";
}

function reconcileToolCallMessages(session: Session, state: RunState): number {
  const runToolCallIds = new Set(state.toolCalls.map((call) => call.id));
  const batchStartByCall = new Map<string, number>();
  for (let index = 0; index < session.messages.length; index += 1) {
    const message = session.messages[index]!;
    if (message.role !== "assistant" || !Array.isArray(message.metadata?.toolCalls)) continue;
    for (const item of message.metadata.toolCalls) {
      if (typeof item !== "object" || item === null) continue;
      const callId = String((item as { id?: unknown }).id);
      if (runToolCallIds.has(callId)) batchStartByCall.set(callId, index);
    }
  }

  const recordedToolCalls = new Set<string>();
  for (const call of state.toolCalls) {
    const batchStart = batchStartByCall.get(call.id);
    if (batchStart === undefined) continue;
    for (let index = batchStart + 1; index < session.messages.length; index += 1) {
      const message = session.messages[index]!;
      if (message.role === "assistant") break;
      if (message.role === "tool" && message.toolCallId === call.id) {
        recordedToolCalls.add(call.id);
        break;
      }
    }
  }

  let interrupted = 0;
  for (const call of state.toolCalls) {
    let result: unknown;
    if (call.status === "completed") {
      result = call.result;
    } else if (call.status === "failed") {
      result = { error: "ToolExecutionError", message: call.error ?? "Tool execution failed" };
    } else {
      if (call.status === "running" || call.status === "pending") {
        call.status = "interrupted";
        call.error = "Execution interrupted before a durable result was recorded";
        interrupted += 1;
      }
      result = {
        error: "InterruptedToolCall",
        message: "工具执行状态未知，未自动重试，需由后续运行重新判断。",
      };
    }
    if (recordedToolCalls.has(call.id) || !batchStartByCall.has(call.id)) continue;
    session.messages.push(createMessage({
      role: "tool",
      name: call.name,
      toolCallId: call.id,
      content: serializeToolResult(result),
    }));
    recordedToolCalls.add(call.id);
  }
  return interrupted;
}

function snapshotRunTurnInput(input: RunTurnInput): RunTurnInput {
  return {
    sessionId: input.sessionId,
    userInput: input.userInput,
    promptInjections: input.promptInjections ? [...input.promptInjections] : undefined,
    skills: input.skills ? [...input.skills] : undefined,
    tools: input.tools ? [...input.tools] : undefined,
    signal: input.signal,
    onEvent: input.onEvent,
  };
}

function normalizeModelContent(content: unknown): string {
  if (content === undefined) return "";
  if (typeof content !== "string") throw new Error("Model response content must be a string");
  return content;
}

function normalizeToolCalls(calls: readonly ToolCall[] | undefined): ToolCall[] {
  if (calls === undefined) return [];
  if (!Array.isArray(calls)) throw new Error("Model response toolCalls must be an array");
  return calls.map((call) => {
    if (!call || typeof call.id !== "string" || typeof call.name !== "string") {
      throw new Error("Model tool calls require string id and name");
    }
    const serialized = JSON.stringify(call.arguments);
    if (serialized === undefined) throw new Error(`Tool call ${call.id} arguments must be JSON`);
    const arguments_ = JSON.parse(serialized) as unknown;
    if (arguments_ === null || typeof arguments_ !== "object" || Array.isArray(arguments_)) {
      throw new Error(`Tool call ${call.id} arguments must be an object`);
    }
    return { id: call.id, name: call.name, arguments: arguments_ as Record<string, unknown> };
  });
}

function immutableSnapshot<T>(value: T): T {
  return deepFreeze(structuredClone(value));
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

function assertUniqueToolCallIds(
  calls: readonly { id: string }[],
  runState: RunState,
): void {
  const seen = new Set(runState.toolCalls.map((call) => call.id));
  for (const call of calls) {
    if (seen.has(call.id)) throw new Error(`Duplicate tool call ID in run: ${call.id}`);
    seen.add(call.id);
  }
}

function notifyObserver(
  handler: AgentLoopEventHandler | undefined,
  event: AgentLoopEvent,
): void {
  if (!handler) return;
  try {
    void Promise.resolve(handler(event)).catch(() => undefined);
  } catch {
    // Event delivery is deliberately best-effort. Canonical run state has its
    // own persistence path and cannot depend on an observer staying connected.
  }
}

export { ToolRegistry };
