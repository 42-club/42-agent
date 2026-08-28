import assert from "node:assert/strict";
import test from "node:test";
import {
  AdaptedModelClient,
  AgentLoop,
  InMemorySessionStore,
  ToolRegistry,
  type ModelRequest,
  type ModelStreamEvent,
} from "../src/index.js";

test("a non-streaming adapted provider keeps AgentLoop retry semantics", async () => {
  let attempts = 0;
  const client = new AdaptedModelClient<Record<string, never>, { answer: string }, never>(
    {
      async complete() {
        attempts += 1;
        if (attempts < 3) throw new Error("transient provider failure");
        return { answer: "recovered" };
      },
    },
    {
      toProviderRequest(_request: ModelRequest) { return {}; },
      fromProviderResponse(response) { return { content: response.answer }; },
      fromProviderStreamEvent(_event) { return null; },
    },
  );

  assert.equal(client.stream, undefined);
  const loop = new AgentLoop({
    model: client,
    tools: new ToolRegistry(),
    sessionStore: new InMemorySessionStore(),
    requestApproval: async () => false,
    config: { retry: { maxAttempts: 3, baseDelayMs: 1 } },
  });

  assert.equal(await loop.runTurn({ sessionId: "adapted-retry", userInput: "go" }), "recovered");
  assert.equal(attempts, 3);
});

test("a streaming adapted provider preserves transport context, cancellation, and done", async () => {
  type ProviderEvent =
    | { kind: "delta"; value: string }
    | { kind: "ignored" }
    | { kind: "finish" };
  const controller = new AbortController();
  const transport = {
    id: "bound-transport",
    async complete() {
      return { answer: "unused" };
    },
    async *stream(_request: { prompt: string }, signal?: AbortSignal) {
      assert.equal(this.id, "bound-transport");
      assert.equal(signal, controller.signal);
      yield { kind: "delta", value: "hello" } as ProviderEvent;
      yield { kind: "ignored" } as ProviderEvent;
      yield { kind: "finish" } as ProviderEvent;
    },
  };
  const client = new AdaptedModelClient<
    { prompt: string },
    { answer: string },
    ProviderEvent
  >(transport, {
    toProviderRequest(request) {
      return { prompt: request.messages.at(-1)?.content ?? "" };
    },
    fromProviderResponse(response) {
      return { content: response.answer };
    },
    fromProviderStreamEvent(event): ModelStreamEvent | null {
      if (event.kind === "delta") return { type: "text_delta", delta: event.value };
      if (event.kind === "finish") return { type: "done" };
      return null;
    },
  });

  assert.ok(client.stream);
  const events: ModelStreamEvent[] = [];
  for await (const event of client.stream({
    messages: [{ role: "user", content: "go" }],
    tools: [],
    systemPrompt: "",
    signal: controller.signal,
  })) events.push(event);

  assert.deepEqual(events, [
    { type: "text_delta", delta: "hello" },
    { type: "done" },
  ]);
});
