import assert from "node:assert/strict";
import test from "node:test";
import {
  AdaptedModelClient,
  AgentLoop,
  ConversationCompressionTool,
  InMemorySessionStore,
  ModelRunner,
  type ModelClient,
  type ModelRequest,
  type ModelResponse,
  type ModelStreamEvent,
  RetryPolicy,
  ToolRegistry,
  createMessage,
} from "../src/index.js";

function createLoop(model: ModelClient, store = new InMemorySessionStore()): AgentLoop {
  const tools = new ToolRegistry();
  tools.register(new ConversationCompressionTool(model));
  return new AgentLoop({
    model,
    tools,
    sessionStore: store,
    requestApproval: async () => true,
    config: { retry: { maxAttempts: 3, baseDelayMs: 1 } },
  });
}

test("emits streaming deltas and persists the final response", async () => {
  const model: ModelClient = {
    async complete() {
      throw new Error("stream should be used");
    },
    async *stream(): AsyncIterable<ModelStreamEvent> {
      yield { type: "text_delta", delta: "hel" };
      yield { type: "text_delta", delta: "lo" };
      yield { type: "done" };
    },
  };
  const deltas: string[] = [];
  const store = new InMemorySessionStore();
  const output = await createLoop(model, store).runTurn({
    sessionId: "stream",
    userInput: "go",
    onEvent(event) {
      if (event.type === "text_delta") deltas.push(event.delta);
    },
  });
  assert.equal(output, "hello");
  assert.deepEqual(deltas, ["hel", "lo"]);
  assert.equal((await store.getOrCreate("stream")).runState?.status, "completed");
});

test("rejects a stream that reaches EOF without an explicit done event", async () => {
  const model: ModelClient = {
    async complete() {
      throw new Error("stream should be used");
    },
    async *stream(): AsyncIterable<ModelStreamEvent> {
      yield { type: "text_delta", delta: "partial" };
    },
  };
  const store = new InMemorySessionStore();

  await assert.rejects(
    createLoop(model, store).runTurn({ sessionId: "incomplete-stream", userInput: "go" }),
    /Model stream ended before a done event/,
  );
  const session = await store.get("incomplete-stream");
  assert.equal(session?.runState?.status, "failed");
  assert.deepEqual(session?.messages.map((message) => message.content), ["go"]);
});

test("rejects an unknown model stream event instead of treating it as done", async () => {
  const model: ModelClient = {
    async complete() {
      throw new Error("stream should be used");
    },
    async *stream(): AsyncIterable<ModelStreamEvent> {
      yield { type: "future-event" } as unknown as ModelStreamEvent;
    },
  };

  await assert.rejects(
    new ModelRunner(model).run({ messages: [], tools: [], systemPrompt: "" }),
    /Unknown model stream event type: future-event/,
  );
});

test("does not start a model stream for a pre-aborted request", async () => {
  let streamCalls = 0;
  const model: ModelClient = {
    async complete() {
      throw new Error("stream should be used");
    },
    async *stream(): AsyncIterable<ModelStreamEvent> {
      streamCalls += 1;
      yield { type: "done" };
    },
  };
  const controller = new AbortController();
  controller.abort(new DOMException("already cancelled", "AbortError"));

  await assert.rejects(
    new ModelRunner(model).run({
      messages: [],
      tools: [],
      systemPrompt: "",
      signal: controller.signal,
    }),
    { name: "AbortError" },
  );
  assert.equal(streamCalls, 0);
});

test("cancellation after a stream delta wins over a later done event", async () => {
  const controller = new AbortController();
  const model: ModelClient = {
    async complete() {
      throw new Error("stream should be used");
    },
    async *stream(): AsyncIterable<ModelStreamEvent> {
      yield { type: "text_delta", delta: "partial" };
      yield { type: "done", response: { content: "must not succeed" } };
    },
  };

  await assert.rejects(
    new ModelRunner(model).run({
      messages: [],
      tools: [],
      systemPrompt: "",
      signal: controller.signal,
    }, {
      onTextDelta() {
        controller.abort(new DOMException("cancel after delta", "AbortError"));
      },
    }),
    { name: "AbortError" },
  );
});

test("uses the final done response and stops consuming later stream events", async () => {
  let reachedAfterDone = false;
  let iteratorClosed = false;
  const model: ModelClient = {
    async complete() {
      throw new Error("stream should be used");
    },
    async *stream(): AsyncIterable<ModelStreamEvent> {
      try {
        yield { type: "text_delta", delta: "draft" };
        yield {
          type: "tool_call",
          call: { id: "draft-call", name: "draft", arguments: {} },
        };
        yield {
          type: "done",
          response: { content: "final", toolCalls: [] },
        };
        reachedAfterDone = true;
        yield { type: "text_delta", delta: "must not be consumed" };
      } finally {
        iteratorClosed = true;
      }
    },
  };
  const deltas: string[] = [];

  const response = await new ModelRunner(model).run({
    messages: [],
    tools: [],
    systemPrompt: "",
  }, {
    onTextDelta(delta) {
      deltas.push(delta);
    },
  });

  assert.deepEqual(response, { content: "final", toolCalls: [] });
  assert.deepEqual(deltas, ["draft"]);
  assert.equal(reachedAfterDone, false);
  assert.equal(iteratorClosed, true);
});

test("retries transient model failures", async () => {
  let attempts = 0;
  const model: ModelClient = {
    async complete(): Promise<ModelResponse> {
      attempts += 1;
      if (attempts < 3) throw new Error("transient");
      return { content: "recovered" };
    },
  };
  assert.equal(
    await createLoop(model).runTurn({ sessionId: "retry", userInput: "go" }),
    "recovered",
  );
  assert.equal(attempts, 3);
});

test("cancellation raised by a retry observer skips an already-aborted backoff", async () => {
  const controller = new AbortController();
  const retry = new RetryPolicy({
    maxAttempts: 3,
    baseDelayMs: 100,
    shouldRetry: () => true,
  });
  let attempts = 0;
  let settled = false;
  const outcome = retry.execute(
    async () => {
      attempts += 1;
      throw new Error("retryable");
    },
    controller.signal,
    () => controller.abort(new DOMException("stop retry", "AbortError")),
  ).then(
    () => ({ resolved: true as const, error: undefined }),
    (error: unknown) => ({ resolved: false as const, error }),
  ).finally(() => {
    settled = true;
  });

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, true);
  const result = await outcome;
  assert.equal(result.resolved, false);
  assert.equal((result.error as Error).name, "AbortError");
  assert.equal(attempts, 1);
});

test("applies steering at the next loop barrier", async () => {
  let calls = 0;
  let releaseFirst!: () => void;
  const firstStarted = new Promise<void>((resolve) => (releaseFirst = resolve));
  let continueFirst!: () => void;
  const waitForSteering = new Promise<void>((resolve) => (continueFirst = resolve));
  const model: ModelClient = {
    async complete(request) {
      calls += 1;
      if (calls === 1) {
        releaseFirst();
        await waitForSteering;
        return { content: "initial" };
      }
      assert.equal(request.messages.at(-1)?.content, "change direction");
      return { content: "steered" };
    },
  };
  const loop = createLoop(model);
  const running = loop.runTurn({ sessionId: "steer", userInput: "start" });
  await firstStarted;
  loop.steer("steer", "change direction");
  continueFirst();
  assert.equal(await running, "steered");
  assert.equal(calls, 2);
});

test("cancellation is persisted", async () => {
  const controller = new AbortController();
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const model: ModelClient = {
    async complete(request) {
      markStarted();
      return new Promise((_resolve, reject) => {
        request.signal?.addEventListener("abort", () => reject(request.signal?.reason), {
          once: true,
        });
      });
    },
  };
  const store = new InMemorySessionStore();
  const running = createLoop(model, store).runTurn({
    sessionId: "cancel",
    userInput: "go",
    signal: controller.signal,
  });
  await started;
  controller.abort(new DOMException("stop", "AbortError"));
  await assert.rejects(running);
  assert.equal((await store.getOrCreate("cancel")).runState?.status, "cancelled");
});

test("observer failures cannot corrupt canonical run completion", async () => {
  for (const eventType of ["run_started", "run_completed"] as const) {
    const store = new InMemorySessionStore();
    const model: ModelClient = { async complete() { return { content: "done" }; } };
    const tools = new ToolRegistry();
    tools.register(new ConversationCompressionTool(model));
    const loop = new AgentLoop({
      model,
      tools,
      sessionStore: store,
      requestApproval: async () => true,
      onEvent(event) {
        if (event.type === eventType) throw new Error("observer disconnected");
      },
    });

    assert.equal(
      await loop.runTurn({ sessionId: `observer-${eventType}`, userInput: "go" }),
      "done",
    );
    assert.equal(
      (await store.get(`observer-${eventType}`))?.runState?.status,
      "completed",
    );
  }
});

test("recovers interrupted tool calls without replaying them", async () => {
  const store = new InMemorySessionStore();
  const session = await store.getOrCreate("recover");
  session.messages.push(
    createMessage({
      role: "assistant",
      content: "",
      metadata: { toolCalls: [{ id: "t1", name: "side_effect", arguments: {} }] },
    }),
  );
  session.runState = {
    id: "old-run",
    status: "running",
    phase: "tools",
    round: 0,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    toolCalls: [{ id: "t1", name: "side_effect", arguments: {}, status: "running" }],
  };
  const loop = createLoop({ async complete() { return { content: "ok" }; } }, store);
  const result = await loop.recoverSession("recover");
  assert.deepEqual(result, { recovered: true, interruptedToolCalls: 1 });
  assert.equal(session.runState.status, "interrupted");
  assert.match(session.messages.at(-1)?.content ?? "", /InterruptedToolCall/);
});

test("recovery materializes every durable tool outcome into model-visible messages", async () => {
  const store = new InMemorySessionStore();
  const session = await store.getOrCreate("recover-batch");
  session.messages.push(
    createMessage({
      role: "assistant",
      content: "",
      metadata: { toolCalls: [{ id: "previous", name: "side_effect", arguments: {} }] },
    }),
    createMessage({
      role: "tool",
      name: "side_effect",
      toolCallId: "previous",
      content: JSON.stringify({ prior: true }),
    }),
  );
  session.messages.push(
    createMessage({
      role: "assistant",
      content: "",
      metadata: {
        toolCalls: [
          { id: "completed", name: "side_effect", arguments: {} },
          { id: "failed", name: "side_effect", arguments: {} },
          { id: "running", name: "side_effect", arguments: {} },
        ],
      },
    }),
  );
  const timestamp = new Date().toISOString();
  session.runState = {
    id: "old-batch",
    status: "running",
    phase: "tools",
    round: 0,
    startedAt: timestamp,
    updatedAt: timestamp,
    toolCalls: [
      { id: "previous", name: "side_effect", arguments: {}, status: "completed", result: { prior: true } },
      { id: "completed", name: "side_effect", arguments: {}, status: "completed", result: { ok: true } },
      { id: "failed", name: "side_effect", arguments: {}, status: "failed", error: "boom" },
      { id: "running", name: "side_effect", arguments: {}, status: "running" },
    ],
  };

  const loop = createLoop({ async complete() { return { content: "ok" }; } }, store);
  assert.deepEqual(await loop.recoverSession("recover-batch"), {
    recovered: true,
    interruptedToolCalls: 1,
  });
  const toolMessages = session.messages.filter((message) => message.role === "tool");
  assert.deepEqual(toolMessages.map((message) => message.toolCallId), [
    "previous", "completed", "failed", "running",
  ]);
  assert.deepEqual(JSON.parse(toolMessages[1]!.content), { ok: true });
  assert.match(toolMessages[2]!.content, /ToolExecutionError/);
  assert.match(toolMessages[3]!.content, /InterruptedToolCall/);
});

test("provider adapter isolates provider message formats", async () => {
  interface RawRequest { prompt: string }
  interface RawResponse { answer: string }
  interface RawEvent { token?: string; done?: boolean }
  const client = new AdaptedModelClient<RawRequest, RawResponse, RawEvent>(
    {
      async complete(request) {
        return { answer: request.prompt.toUpperCase() };
      },
    },
    {
      toProviderRequest(request: ModelRequest) {
        return { prompt: request.messages.map((message) => message.content).join("|") };
      },
      fromProviderResponse(response) {
        return { content: response.answer };
      },
      fromProviderStreamEvent(event) {
        if (event.token) return { type: "text_delta", delta: event.token };
        return event.done ? { type: "done" } : null;
      },
    },
  );
  const response = await client.complete({
    messages: [{ role: "user", content: "hello" }],
    tools: [],
    systemPrompt: "",
  });
  assert.equal(response.content, "HELLO");
});
