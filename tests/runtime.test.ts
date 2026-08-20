import assert from "node:assert/strict";
import test from "node:test";
import {
  AdaptedModelClient,
  AgentLoop,
  ConversationCompressionTool,
  InMemorySessionStore,
  type ModelClient,
  type ModelRequest,
  type ModelResponse,
  type ModelStreamEvent,
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
  const model: ModelClient = {
    async complete(request) {
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
  controller.abort(new DOMException("stop", "AbortError"));
  await assert.rejects(running);
  assert.equal((await store.getOrCreate("cancel")).runState?.status, "cancelled");
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
