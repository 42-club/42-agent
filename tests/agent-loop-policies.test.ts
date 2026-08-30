import assert from "node:assert/strict";
import test from "node:test";
import { ModelRequestPlanner } from "../src/runtime/model-request-planner.js";
import { RunFinalizer } from "../src/runtime/run-finalizer.js";
import {
  RunRecovery,
  type RunPolicySessionSnapshot,
} from "../src/runtime/run-recovery.js";

const timestamp = "2026-08-29T00:00:00.000Z";

test("RunRecovery plans protocol repair without mutating its frozen snapshot", () => {
  const snapshot = frozenSession({
    id: "recovery-policy",
    messages: [{
      role: "assistant",
      content: "",
      metadata: { toolCalls: [{ id: "pending", name: "effect", arguments: {} }] },
    }],
    runState: {
      id: "run",
      status: "running",
      phase: "tools",
      round: 0,
      startedAt: timestamp,
      updatedAt: timestamp,
      toolCalls: [{
        id: "pending",
        name: "effect",
        arguments: {},
        status: "running",
      }],
    },
  });

  const plan = new RunRecovery().plan(deepFreeze({ session: snapshot, now: timestamp }));

  assert.equal(plan.kind, "recover");
  if (plan.kind !== "recover") return;
  assert.equal(snapshot.runState?.status, "running");
  assert.equal(snapshot.runState?.toolCalls[0]?.status, "running");
  assert.equal(plan.nextRunState.status, "interrupted");
  assert.equal(plan.nextRunState.toolCalls[0]?.status, "interrupted");
  assert.equal(plan.appendMessages[0]?.toolCallId, "pending");
  assert.match(plan.appendMessages[0]?.content ?? "", /InterruptedToolCall/);
  assert.deepEqual(plan.result, { recovered: true, interruptedToolCalls: 1 });
});

test("RunFinalizer returns terminal checkpoint and event plans without side effects", () => {
  const snapshot = frozenSession({
    id: "finalizer-policy",
    messages: [],
    runState: {
      id: "run",
      status: "running",
      phase: "model",
      round: 1,
      startedAt: timestamp,
      updatedAt: timestamp,
      toolCalls: [],
    },
  });
  const finalizer = new RunFinalizer();

  const completed = finalizer.plan(deepFreeze({
    kind: "completed" as const,
    session: snapshot,
    content: "done",
    now: timestamp,
  }));
  assert.equal(completed.nextRunState.status, "completed");
  assert.equal(completed.saveOptions, undefined);
  assert.deepEqual(completed.event, {
    type: "run_completed",
    sessionId: "finalizer-policy",
    runId: "run",
    content: "done",
  });

  const failed = finalizer.plan(deepFreeze({
    kind: "failed" as const,
    session: snapshot,
    cancelled: false,
    errorMessage: "boom",
    error: { code: "RUNTIME_ERROR", message: "boom", retryable: false },
    now: timestamp,
  }));
  assert.equal(snapshot.runState?.status, "running");
  assert.equal(failed.nextRunState.status, "failed");
  assert.deepEqual(failed.saveOptions, { rewriteMessages: true });
  assert.equal(failed.event.type, "run_failed");
});

test("ModelRequestPlanner owns prompt, budget, and bounded compression decisions", () => {
  const planner = new ModelRequestPlanner();
  assert.equal(planner.buildPrompt(deepFreeze({
    promptInjections: ["channel"],
    skillInstructions: ["skill"],
  })), "channel\n\nskill");

  const budget = planner.resolveBudget(deepFreeze({
    configured: { contextWindowTokens: 1_000 },
  }));
  assert.deepEqual(budget, {
    compressionThresholdTokens: 650,
    maximumInputTokens: 900,
  });
  const messages = deepFreeze([
    { role: "user" as const, content: "old" },
    { role: "user" as const, content: "new" },
  ]);
  const request = planner.createRequest({
    messages,
    tools: deepFreeze([]),
    systemPrompt: "channel\n\nskill",
  });
  assert.equal(Object.isFrozen(request), true);

  const softDecision = planner.plan(deepFreeze({
    request,
    budget,
    estimatedTokens: 700,
    compressionAvailable: true,
    compressionPasses: 0,
  }));
  assert.equal(softDecision.kind, "compress");
  if (softDecision.kind !== "compress") return;
  assert.equal(softDecision.reason, "token_threshold");

  const compressedRequest = planner.createRequest({
    messages: deepFreeze([{ role: "user" as const, content: "summary" }]),
    tools: deepFreeze([]),
    systemPrompt: "channel\n\nskill",
  });
  const ready = planner.plan(deepFreeze({
    request: compressedRequest,
    budget,
    estimatedTokens: 100,
    compressionAvailable: true,
    compressionPasses: 1,
    previousCompression: {
      compressed: true,
      messageCount: softDecision.baseline.messageCount,
      estimatedTokens: softDecision.baseline.estimatedTokens,
    },
  }));
  assert.equal(ready.kind, "ready");

  const bounded = planner.plan(deepFreeze({
    request: compressedRequest,
    budget,
    estimatedTokens: 901,
    compressionAvailable: true,
    compressionPasses: 32,
    previousCompression: { compressed: true, messageCount: 2, estimatedTokens: 902 },
  }));
  assert.equal(bounded.kind, "reject");
});

function frozenSession(session: RunPolicySessionSnapshot): RunPolicySessionSnapshot {
  return deepFreeze(structuredClone(session));
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
