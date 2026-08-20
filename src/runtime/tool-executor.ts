import type { ToolCall } from "../model.js";
import { createMessage, type RunState, type SessionStore } from "../session.js";
import type { ToolContext } from "../tools/base.js";
import { ToolRegistry } from "../tools/base.js";
import type { EventDispatcher } from "./events.js";
import { throwIfAborted } from "./retry.js";

export class ToolExecutor {
  constructor(
    private readonly tools: ToolRegistry,
    private readonly sessions: SessionStore,
    private readonly events: EventDispatcher,
    private readonly maxConcurrency = 4,
  ) {}

  async executeAll(
    calls: readonly ToolCall[],
    context: ToolContext,
    runState: RunState,
  ): Promise<void> {
    runState.phase = "tools";
    runState.toolCalls = calls.map((call) => ({ ...call, status: "pending" }));
    await this.sessions.save(context.session);

    const outcomes = new Map<string, { result?: unknown; error?: string }>();
    let cursor = 0;
    const workers = Array.from({ length: Math.min(this.maxConcurrency, calls.length) }, async () => {
      while (cursor < calls.length) {
        const call = calls[cursor++]!;
        await this.executeOne(call, context, runState, outcomes);
      }
    });
    await Promise.all(workers);

    // Model-visible tool messages are deterministic even when executions finish out of order.
    for (const call of calls) {
      const outcome = outcomes.get(call.id)!;
      const result = outcome.error
        ? { error: "ToolExecutionError", message: outcome.error }
        : outcome.result;
      context.session.messages.push(createMessage({
        role: "tool", name: call.name, toolCallId: call.id, content: JSON.stringify(result),
      }));
    }
    await this.sessions.save(context.session);
  }

  private async executeOne(
    call: ToolCall,
    context: ToolContext,
    runState: RunState,
    outcomes: Map<string, { result?: unknown; error?: string }>,
  ): Promise<void> {
      throwIfAborted(context.signal);
      const state = runState.toolCalls.find((candidate) => candidate.id === call.id)!;
      state.status = "running";
      runState.updatedAt = new Date().toISOString();
      await this.sessions.save(context.session);
      await this.events.emit({
        type: "tool_call_started",
        sessionId: context.session.id,
        runId: runState.id,
        call,
      });

      try {
        const tool = this.tools.get(call.name);
        this.tools.validate(call.name, call.arguments);
        const result = await tool.execute(call.arguments, this.tools.contextFor(tool, context));
        state.status = "completed";
        state.result = result;
        outcomes.set(call.id, { result });
        await this.events.emit({
          type: "tool_call_completed",
          sessionId: context.session.id,
          runId: runState.id,
          call,
          result,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        state.status = "failed";
        state.error = message;
        outcomes.set(call.id, { error: message });
        await this.events.emit({
          type: "tool_call_failed",
          sessionId: context.session.id,
          runId: runState.id,
          call,
          error: message,
        });
      }
      runState.updatedAt = new Date().toISOString();
      await this.sessions.save(context.session);
  }
}
