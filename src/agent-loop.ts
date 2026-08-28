import { randomUUID } from "node:crypto";
import { estimateTokens, type ModelClient } from "./model.js";
import { buildSystemPrompt } from "./prompt.js";
import { EventDispatcher, type AgentLoopEventHandler } from "./runtime/events.js";
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

  steer(sessionId: string, message: string): void {
    this.steering.enqueue(sessionId, message);
  }

  async recoverSession(sessionId: string): Promise<RecoveryResult> {
    const session = await this.dependencies.sessionStore.getOrCreate(sessionId);
    const state = session.runState;
    if (!state || state.status !== "running") {
      return { recovered: false, interruptedToolCalls: 0 };
    }

    let interruptedToolCalls = 0;
    for (const call of state.toolCalls) {
      if (call.status !== "running" && call.status !== "pending") continue;
      call.status = "interrupted";
      call.error = "Execution interrupted before a durable result was recorded";
      interruptedToolCalls += 1;
      session.messages.push(
        createMessage({
          role: "tool",
          name: call.name,
          toolCallId: call.id,
          content: JSON.stringify({
            error: "InterruptedToolCall",
            message: "工具执行状态未知，未自动重试，需由后续运行重新判断。",
          }),
        }),
      );
    }
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
    return this.enqueueSession(input.sessionId, () => this.runTurnSerialized(input));
  }

  private async runTurnSerialized(input: RunTurnInput): Promise<TurnExecutionResult> {
    await this.recoverSession(input.sessionId);
    const session = await this.dependencies.sessionStore.getOrCreate(input.sessionId);
    const runState = createRunState();
    session.runState = runState;
    session.messages.push(createMessage({ role: "user", content: input.userInput }));
    const events = new EventDispatcher(async (event) => {
      await this.dependencies.onEvent?.(event);
      await input.onEvent?.(event);
    });
    const modelRunner = new ModelRunner(this.dependencies.model, this.retry);
    const activeTools = input.tools
      ? this.dependencies.tools.select(input.tools)
      : this.dependencies.tools;
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
    await events.emit({ type: "run_started", sessionId: session.id, runId: runState.id });

    try {
      throwIfAborted(input.signal);
      const estimatedHistoryTokens = session.messages.reduce((sum, message) => sum + estimateTokens(message.content) + 4, 0);
      // compressionThreshold remains as a backwards-compatible explicit override.
      if (estimatedHistoryTokens >= this.compressionThresholdTokens
        || (this.dependencies.config?.compressionThreshold !== undefined && session.messages.length >= this.compressionThreshold)) {
        const compression = this.dependencies.tools.get("compress_conversation");
        this.dependencies.tools.validate(compression.name, {});
        const result = await compression.execute(
          {},
          this.dependencies.tools.contextFor(compression, toolContext),
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
            messages: session.messages,
            tools: activeTools.definitions(),
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
        const calls = response.toolCalls ?? [];
        const content = response.content ?? "";
        session.messages.push(
          createMessage({
            role: "assistant",
            content,
            metadata: calls.length ? { toolCalls: calls } : undefined,
          }),
        );

        if (calls.length > 0) {
          await toolExecutor.executeAll(calls, toolContext, runState);
          await this.applySteering(session, runState, events);
          continue;
        }

        const steeringCount = await this.applySteering(session, runState, events);
        if (steeringCount > 0) continue;

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
      const cancelled = input.signal?.aborted || isAbortError(error);
      runState.status = cancelled ? "cancelled" : "failed";
      runState.phase = "idle";
      runState.error = error instanceof Error ? error.message : String(error);
      touch(runState);
      await this.dependencies.sessionStore.save(session);
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
  ): Promise<number> {
    const messages = this.steering.drain(session.id);
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

export { ToolRegistry };
