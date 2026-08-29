import assert from "node:assert/strict";
import test from "node:test";
import {
  AgentLoop, InMemorySessionStore, ToolRegistry,
  createMessage, type ModelClient, type SaveSessionOptions, type Session,
  type RunState, type SessionStore, type Tool,
} from "../src/index.js";
import { EventDispatcher, ToolExecutor } from "../src/legacy/index.js";
import { ConversationCompressionTool } from "../src/tools/index.js";

class FailOneSaveStore implements SessionStore {
  private saves = 0;

  constructor(
    private readonly base: SessionStore,
    private readonly failAt: number,
  ) {}

  get(sessionId: string) { return this.base.get(sessionId); }
  create(sessionId: string, metadata?: Record<string, unknown>) {
    return this.base.create(sessionId, metadata);
  }
  getOrCreate(sessionId: string) { return this.base.getOrCreate(sessionId); }
  delete(sessionId: string) { return this.base.delete(sessionId); }
  save(session: Session, options?: SaveSessionOptions): Promise<void> {
    this.saves += 1;
    if (this.saves === this.failAt) return Promise.reject(new Error("injected checkpoint failure"));
    return this.base.save(session, options);
  }
}

class ConcurrentSaveProbeStore implements SessionStore {
  private activeSaves = 0;
  maximumActiveSaves = 0;

  constructor(private readonly base: SessionStore) {}

  get(sessionId: string) { return this.base.get(sessionId); }
  create(sessionId: string, metadata?: Record<string, unknown>) {
    return this.base.create(sessionId, metadata);
  }
  getOrCreate(sessionId: string) { return this.base.getOrCreate(sessionId); }
  delete(sessionId: string) { return this.base.delete(sessionId); }
  async save(session: Session, options?: SaveSessionOptions): Promise<void> {
    this.activeSaves += 1;
    this.maximumActiveSaves = Math.max(this.maximumActiveSaves, this.activeSaves);
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      await this.base.save(session, options);
    } finally {
      this.activeSaves -= 1;
    }
  }
}

test("legacy ToolExecutor constructor remains compatible", async () => {
  const store = new InMemorySessionStore();
  const session = await store.create("legacy-tool-executor");
  const tools = new ToolRegistry();
  tools.register({
    name: "echo",
    description: "Echo a value",
    inputSchema: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
      additionalProperties: false,
    },
    async execute(input) {
      return { value: input.value };
    },
  });
  const runState: RunState = {
    id: "legacy-run",
    status: "running",
    phase: "idle",
    round: 0,
    startedAt: "2026-08-29T00:00:00.000Z",
    updatedAt: "2026-08-29T00:00:00.000Z",
    toolCalls: [],
  };
  const executor = new ToolExecutor(tools, store, new EventDispatcher());

  await executor.executeAll(
    [{ id: "legacy-call", name: "echo", arguments: { value: "ok" } }],
    { session, requestApproval: async () => false },
    runState,
  );

  assert.equal(runState.toolCalls[0]?.status, "completed");
  assert.deepEqual(JSON.parse(session.messages[0]?.content ?? "null"), { value: "ok" });
  assert.equal((await store.get(session.id))?.messages[0]?.toolCallId, "legacy-call");
});

test("one tool batch runs concurrently and returns results in call order", async () => {
  let modelCalls = 0;
  const observed: string[] = [];
  const completionOrder: string[] = [];
  const model: ModelClient = {
    async complete({ messages }) {
      modelCalls += 1;
      if (modelCalls === 1) return {
        toolCalls: [
          { id: "slow", name: "delay", arguments: { value: "slow", ms: 30 } },
          { id: "fast", name: "delay", arguments: { value: "fast", ms: 1 } },
        ],
      };
      observed.push(...messages.filter((message) => message.role === "tool").map((message) => message.toolCallId!));
      return { content: "done" };
    },
  };
  const delay: Tool = {
    name: "delay", description: "delay",
    inputSchema: { type: "object", properties: { value: { type: "string" }, ms: { type: "number" } }, required: ["value", "ms"], additionalProperties: false },
    async execute(input) {
      await new Promise((resolve) => setTimeout(resolve, Number(input.ms)));
      completionOrder.push(String(input.value));
      return input.value;
    },
  };
  const tools = new ToolRegistry();
  tools.register(new ConversationCompressionTool(model));
  tools.register(delay);
  const loop = new AgentLoop({ model, tools, sessionStore: new InMemorySessionStore(), requestApproval: async () => false });
  assert.equal(await loop.runTurn({ sessionId: "parallel", userInput: "go" }), "done");
  assert.deepEqual(completionOrder, ["fast", "slow"]);
  assert.deepEqual(observed, ["slow", "fast"]);
});

test("tool input is validated before execution", async () => {
  let executed = false;
  let calls = 0;
  const model: ModelClient = {
    async complete() {
      calls += 1;
      return calls === 1
        ? { toolCalls: [{ id: "bad", name: "typed", arguments: { count: "wrong" } }] }
        : { content: "handled" };
    },
  };
  const tools = new ToolRegistry();
  tools.register(new ConversationCompressionTool(model));
  tools.register({
    name: "typed", description: "typed",
    inputSchema: { type: "object", properties: { count: { type: "number" } }, required: ["count"] },
    async execute() { executed = true; },
  });
  const loop = new AgentLoop({ model, tools, sessionStore: new InMemorySessionStore(), requestApproval: async () => false });
  await loop.runTurn({ sessionId: "schema", userInput: "go" });
  assert.equal(executed, false);
});

test("a failed tool checkpoint still closes the assistant tool-call batch", async () => {
  const base = new InMemorySessionStore();
  const store = new FailOneSaveStore(base, 3);
  let modelCalls = 0;
  let toolExecuted = false;
  const model: ModelClient = {
    async complete({ messages }) {
      modelCalls += 1;
      if (modelCalls === 1) {
        return { toolCalls: [{ id: "checkpointed", name: "effect", arguments: {} }] };
      }
      assert.deepEqual(messages.map((message) => message.role), [
        "user", "assistant", "tool", "user",
      ]);
      assert.match(messages[2]!.content, /InterruptedToolCall/);
      return { content: "history recovered" };
    },
  };
  const tools = new ToolRegistry();
  tools.register({
    name: "effect",
    description: "must not execute after pending checkpoint failure",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async execute() {
      toolExecuted = true;
      return { ok: true };
    },
  });
  const loop = new AgentLoop({
    model,
    tools,
    sessionStore: store,
    requestApproval: async () => false,
  });

  await assert.rejects(
    loop.runTurn({ sessionId: "checkpoint-failure", userInput: "first" }),
    /injected checkpoint failure/,
  );
  const failed = await base.get("checkpoint-failure");
  assert.equal(toolExecuted, false);
  assert.equal(failed?.runState?.status, "failed");
  assert.equal(failed?.runState?.toolCalls[0]?.status, "interrupted");
  assert.deepEqual(failed?.messages.map((message) => message.role), ["user", "assistant", "tool"]);

  assert.equal(
    await loop.runTurn({ sessionId: "checkpoint-failure", userInput: "second" }),
    "history recovered",
  );
});

test("read-only tools cannot mutate the live session through their context", async () => {
  let modelCalls = 0;
  const store = new InMemorySessionStore();
  const model: ModelClient = {
    async complete({ messages }) {
      modelCalls += 1;
      if (modelCalls === 1) {
        return { toolCalls: [{ id: "attempt", name: "read_only", arguments: {} }] };
      }
      assert.equal(messages.some((message) => message.content === "forged history"), false);
      return { content: "history intact" };
    },
  };
  const tools = new ToolRegistry();
  tools.register(new ConversationCompressionTool(model));
  tools.register({
    name: "read_only",
    description: "Attempt to mutate session history",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async execute(_input, context) {
      const exposed = context.session as unknown as Session;
      assert.throws(
        () => exposed.messages.push(createMessage({ role: "user", content: "forged history" })),
        TypeError,
      );
      return { protected: true };
    },
  });
  const loop = new AgentLoop({
    model,
    tools,
    sessionStore: store,
    requestApproval: async () => false,
  });

  assert.equal(await loop.runTurn({ sessionId: "read-only", userInput: "go" }), "history intact");
  const session = await store.getOrCreate("read-only");
  assert.equal(session.messages.some((message) => message.content === "forged history"), false);
});

test("tool arguments and observer events are detached from canonical state", async () => {
  let modelCalls = 0;
  const store = new InMemorySessionStore();
  const model: ModelClient = {
    async complete({ messages }) {
      modelCalls += 1;
      if (modelCalls === 1) {
        return {
          toolCalls: [{
            id: "immutable-call",
            name: "inspect",
            arguments: { nested: { value: "original" } },
          }],
        };
      }
      const assistant = messages.find((message) => Array.isArray(message.metadata?.toolCalls));
      const calls = assistant?.metadata?.toolCalls as Array<{
        arguments: { nested: { value: string } };
      }>;
      assert.equal(calls[0]?.arguments.nested.value, "original");
      const result = JSON.parse(messages.find((message) => (
        message.toolCallId === "immutable-call"
      ))!.content) as { value: string };
      assert.equal(result.value, "original");
      return { content: "intact" };
    },
  };
  const tools = new ToolRegistry();
  tools.register({
    name: "inspect",
    description: "Try to mutate its input",
    inputSchema: {
      type: "object",
      properties: {
        nested: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
        },
      },
      required: ["nested"],
    },
    async execute(input) {
      const nested = input.nested as { value: string };
      const original = nested.value;
      nested.value = "tool-local-mutation";
      return { value: original };
    },
  });
  const loop = new AgentLoop({
    model,
    tools,
    sessionStore: store,
    requestApproval: async () => false,
  });

  assert.equal(await loop.runTurn({
    sessionId: "detached-tool-data",
    userInput: "go",
    onEvent(event) {
      if (event.type === "tool_call_started") {
        assert.throws(() => {
          (event.call.arguments.nested as { value: string }).value = "observer-mutated";
        }, TypeError);
      }
      if (event.type === "tool_call_completed") {
        assert.throws(() => {
          (event.result as { value: string }).value = "observer-mutated";
        }, TypeError);
      }
    },
  }), "intact");

  const session = await store.get("detached-tool-data");
  assert.equal(
    (session?.runState?.toolCalls[0]?.arguments.nested as { value: string }).value,
    "original",
  );
  assert.deepEqual(session?.runState?.toolCalls[0]?.result, { value: "original" });
});

test("cancellation stops dispatch and waits for every started tool before returning", async () => {
  const controller = new AbortController();
  const store = new InMemorySessionStore();
  const started: string[] = [];
  const settled: string[] = [];
  let releaseTools!: () => void;
  const toolsMayFinish = new Promise<void>((resolve) => { releaseTools = resolve; });
  let reportFourStarted!: () => void;
  const fourStarted = new Promise<void>((resolve) => { reportFourStarted = resolve; });
  let modelCalls = 0;
  const model: ModelClient = {
    async complete() {
      modelCalls += 1;
      if (modelCalls > 1) throw new Error("cancelled batch must not call the model again");
      return {
        toolCalls: Array.from({ length: 5 }, (_, index) => ({
          id: `call-${index + 1}`,
          name: "blocking",
          arguments: { id: `call-${index + 1}` },
        })),
      };
    },
  };
  const registry = new ToolRegistry();
  registry.register(new ConversationCompressionTool(model));
  registry.register({
    name: "blocking",
    description: "Wait until the test releases all started calls",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
    async execute(input) {
      const id = String(input.id);
      started.push(id);
      if (started.length === 4) reportFourStarted();
      // Deliberately ignore the abort signal. The executor still has to join this
      // already-started side effect before the turn is allowed to finish.
      await toolsMayFinish;
      settled.push(id);
      return id;
    },
  });
  const loop = new AgentLoop({
    model,
    tools: registry,
    sessionStore: store,
    requestApproval: async () => false,
  });

  const running = loop.runTurn({
    sessionId: "cancel-tool-batch",
    userInput: "go",
    signal: controller.signal,
  });
  let turnFinished = false;
  const observed = running.then(
    () => ({ resolved: true as const, error: undefined }),
    (error: unknown) => ({ resolved: false as const, error }),
  ).finally(() => { turnFinished = true; });

  await fourStarted;
  controller.abort(new DOMException("stop", "AbortError"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(turnFinished, false, "turn returned while started tools were still running");
  assert.deepEqual(started, ["call-1", "call-2", "call-3", "call-4"]);

  releaseTools();
  const result = await observed;
  assert.equal(result.resolved, false);
  assert.equal((result.error as Error).name, "AbortError");
  assert.deepEqual(settled, started);
  assert.equal(modelCalls, 1);

  const session = await store.getOrCreate("cancel-tool-batch");
  assert.equal(session.runState?.status, "cancelled");
  assert.deepEqual(
    session.messages.filter((message) => message.role === "tool").map((message) => message.toolCallId),
    ["call-1", "call-2", "call-3", "call-4", "call-5"],
  );
  assert.deepEqual(
    session.runState?.toolCalls.map((call) => call.status),
    ["completed", "completed", "completed", "completed", "interrupted"],
  );
});

test("tool event observer failures cannot rewrite a durable success", async () => {
  let modelCalls = 0;
  let executions = 0;
  const model: ModelClient = {
    async complete({ messages }) {
      modelCalls += 1;
      if (modelCalls === 1) {
        return { toolCalls: [{ id: "side-effect", name: "side_effect", arguments: {} }] };
      }
      const result = messages.find((message) => message.toolCallId === "side-effect");
      assert.deepEqual(JSON.parse(result?.content ?? "null"), { committed: true });
      return { content: "done" };
    },
  };
  const registry = new ToolRegistry();
  registry.register(new ConversationCompressionTool(model));
  registry.register({
    name: "side_effect",
    description: "Commit one side effect",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async execute() {
      executions += 1;
      return { committed: true };
    },
  });
  const loop = new AgentLoop({
    model,
    tools: registry,
    sessionStore: new InMemorySessionStore(),
    requestApproval: async () => false,
  });

  assert.equal(await loop.runTurn({
    sessionId: "observer-failure",
    userInput: "go",
    onEvent(event) {
      if (event.type === "tool_call_completed") throw new Error("channel disconnected");
    },
  }), "done");
  assert.equal(executions, 1);
});

test("duplicate tool call IDs in one batch are rejected before execution", async () => {
  let executions = 0;
  const model: ModelClient = {
    async complete() {
      return {
        toolCalls: [
          { id: "duplicate", name: "noop", arguments: {} },
          { id: "duplicate", name: "noop", arguments: {} },
        ],
      };
    },
  };
  const registry = new ToolRegistry();
  registry.register(new ConversationCompressionTool(model));
  registry.register({
    name: "noop",
    description: "Must not run",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async execute() { executions += 1; },
  });
  const store = new InMemorySessionStore();
  const loop = new AgentLoop({
    model,
    tools: registry,
    sessionStore: store,
    requestApproval: async () => false,
  });

  await assert.rejects(
    loop.runTurn({ sessionId: "duplicate-call-ids", userInput: "go" }),
    /Duplicate tool call ID in run: duplicate/,
  );
  assert.equal(executions, 0);
  assert.deepEqual((await store.get("duplicate-call-ids"))?.messages.map((message) => message.role), [
    "user",
  ]);
});

test("write-access tools are serialized in model call order", async () => {
  let modelCalls = 0;
  let activeWrites = 0;
  let maximumActiveWrites = 0;
  const executionOrder: string[] = [];
  const model: ModelClient = {
    async complete() {
      modelCalls += 1;
      if (modelCalls === 1) {
        return {
          toolCalls: [
            { id: "write-1", name: "writer", arguments: { value: "first", ms: 25 } },
            { id: "write-2", name: "writer", arguments: { value: "second", ms: 1 } },
          ],
        };
      }
      return { content: "done" };
    },
  };
  const registry = new ToolRegistry();
  registry.register(new ConversationCompressionTool(model));
  registry.register({
    name: "writer",
    description: "Mutate live session state",
    sessionAccess: "write",
    inputSchema: {
      type: "object",
      properties: { value: { type: "string" }, ms: { type: "number" } },
      required: ["value", "ms"],
      additionalProperties: false,
    },
    async execute(input, context) {
      const value = String(input.value);
      assert.ok(context.mutableSession);
      activeWrites += 1;
      maximumActiveWrites = Math.max(maximumActiveWrites, activeWrites);
      executionOrder.push(`start:${value}`);
      await new Promise((resolve) => setTimeout(resolve, Number(input.ms)));
      const order = (context.mutableSession.metadata.writeOrder ??= []) as string[];
      order.push(value);
      executionOrder.push(`end:${value}`);
      activeWrites -= 1;
      return value;
    },
  });
  const store = new InMemorySessionStore();
  const loop = new AgentLoop({
    model,
    tools: registry,
    sessionStore: store,
    requestApproval: async () => false,
  });

  assert.equal(await loop.runTurn({ sessionId: "serialized-writes", userInput: "go" }), "done");
  assert.equal(maximumActiveWrites, 1);
  assert.deepEqual(executionOrder, [
    "start:first", "end:first", "start:second", "end:second",
  ]);
  assert.deepEqual((await store.getOrCreate("serialized-writes")).metadata.writeOrder, [
    "first", "second",
  ]);
});

test("exclusive tools serialize external effects without Session write access", async () => {
  let modelCalls = 0;
  let active = 0;
  let maximumActive = 0;
  const order: string[] = [];
  const model: ModelClient = {
    async complete() {
      modelCalls += 1;
      return modelCalls === 1
        ? {
          toolCalls: [
            { id: "external-1", name: "external", arguments: { id: "first", ms: 15 } },
            { id: "external-2", name: "external", arguments: { id: "second", ms: 1 } },
          ],
        }
        : { content: "done" };
    },
  };
  const tools = new ToolRegistry();
  tools.register({
    name: "external",
    description: "Ordered external side effect",
    executionPolicy: "exclusive",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, ms: { type: "number" } },
      required: ["id", "ms"],
    },
    async execute(input, context) {
      assert.equal(context.mutableSession, undefined);
      const id = String(input.id);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      order.push(`start:${id}`);
      await new Promise((resolve) => setTimeout(resolve, Number(input.ms)));
      order.push(`end:${id}`);
      active -= 1;
      return id;
    },
  });
  const loop = new AgentLoop({
    model,
    tools,
    sessionStore: new InMemorySessionStore(),
    requestApproval: async () => false,
  });

  assert.equal(await loop.runTurn({ sessionId: "exclusive-external", userInput: "go" }), "done");
  assert.equal(maximumActive, 1);
  assert.deepEqual(order, [
    "start:first", "end:first", "start:second", "end:second",
  ]);
});

test("non-JSON tool results become model-visible failures without corrupting persistence", async () => {
  let modelCalls = 0;
  const model: ModelClient = {
    async complete({ messages }) {
      modelCalls += 1;
      if (modelCalls === 1) {
        return { toolCalls: [{ id: "bigint", name: "invalid_result", arguments: {} }] };
      }
      const result = JSON.parse(messages.find((message) => message.toolCallId === "bigint")!.content);
      assert.equal(result.error, "ToolExecutionError");
      return { content: "handled" };
    },
  };
  const registry = new ToolRegistry();
  registry.register({
    name: "invalid_result",
    description: "Return a value that JSON stores cannot persist",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async execute() { return 1n; },
  });
  const store = new InMemorySessionStore();
  const loop = new AgentLoop({
    model,
    tools: registry,
    sessionStore: store,
    requestApproval: async () => false,
  });

  assert.equal(await loop.runTurn({ sessionId: "invalid-result", userInput: "go" }), "handled");
  assert.equal((await store.get("invalid-result"))?.runState?.toolCalls[0]?.status, "failed");
});

test("AgentLoop mutation gate serializes checkpoints from parallel tool workers", async () => {
  let modelCalls = 0;
  const model: ModelClient = {
    async complete() {
      modelCalls += 1;
      return modelCalls === 1
        ? {
            toolCalls: Array.from({ length: 4 }, (_, index) => ({
              id: `parallel-${index}`,
              name: "parallel",
              arguments: {},
            })),
          }
        : { content: "done" };
    },
  };
  const tools = new ToolRegistry();
  tools.register({
    name: "parallel",
    description: "Complete without blocking other workers",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async execute() { return { ok: true }; },
  });
  const store = new ConcurrentSaveProbeStore(new InMemorySessionStore());
  const loop = new AgentLoop({
    model,
    tools,
    sessionStore: store,
    requestApproval: async () => false,
  });

  assert.equal(await loop.runTurn({ sessionId: "mutation-gate", userInput: "go" }), "done");
  assert.equal(store.maximumActiveSaves, 1);
});
