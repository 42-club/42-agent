import assert from "node:assert/strict";
import test from "node:test";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import {
  AiSdkModelClient,
  createAiSdkOpenRouterClient,
  createMessage,
  type ModelStreamEvent,
} from "../src/index.js";

const usage = {
  inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 2, text: 2, reasoning: 0 },
};

test("AI SDK client converts canonical messages, tools, and generated tool calls", async () => {
  const model = new MockLanguageModelV4({
    doGenerate: {
      content: [
        { type: "text", text: "checking" },
        {
          type: "tool-call",
          toolCallId: "call-2",
          toolName: "lookup",
          input: JSON.stringify({ query: "runtime" }),
        },
      ],
      finishReason: { unified: "tool-calls", raw: "tool_calls" },
      usage,
      warnings: [],
    },
  });
  const client = new AiSdkModelClient(model);
  const controller = new AbortController();

  const response = await client.complete({
    systemPrompt: "Stay precise.",
    signal: controller.signal,
    tools: [{
      name: "lookup",
      description: "Look up a value",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
        additionalProperties: false,
      },
    }],
    messages: [
      createMessage({ role: "user", content: "first" }),
      createMessage({
        role: "assistant",
        content: "",
        metadata: {
          toolCalls: [{ id: "call-1", name: "lookup", arguments: { query: "old" } }],
        },
      }),
      createMessage({
        role: "tool",
        name: "lookup",
        toolCallId: "call-1",
        content: JSON.stringify({ value: 42 }),
      }),
    ],
  });

  assert.deepEqual(response, {
    content: "checking",
    toolCalls: [{ id: "call-2", name: "lookup", arguments: { query: "runtime" } }],
  });
  assert.equal(model.doGenerateCalls.length, 1);
  const call = model.doGenerateCalls[0]!;
  assert.equal(call.abortSignal, controller.signal);
  assert.equal(call.prompt[0]?.role, "system");
  assert.equal(call.prompt[1]?.role, "user");
  assert.equal(call.prompt[2]?.role, "assistant");
  assert.equal(call.prompt[3]?.role, "tool");
  assert.equal(call.tools?.[0]?.name, "lookup");
});

test("AI SDK client streams text and tool calls and terminates with done", async () => {
  const model = new MockLanguageModelV4({
    doStream: {
      stream: simulateReadableStream({
        chunks: [
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "text-1" },
          { type: "text-delta", id: "text-1", delta: "hel" },
          { type: "text-delta", id: "text-1", delta: "lo" },
          { type: "text-end", id: "text-1" },
          {
            type: "tool-input-start",
            id: "call-1",
            toolName: "lookup",
          },
          {
            type: "tool-input-delta",
            id: "call-1",
            delta: JSON.stringify({ query: "x" }),
          },
          { type: "tool-input-end", id: "call-1" },
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "lookup",
            input: JSON.stringify({ query: "x" }),
          },
          {
            type: "finish",
            finishReason: { unified: "tool-calls", raw: "tool_calls" },
            usage,
          },
        ],
      }),
    },
  });
  const client = new AiSdkModelClient(model);
  const events = [];

  for await (const event of client.stream({
    systemPrompt: "",
    messages: [createMessage({ role: "user", content: "hello" })],
    tools: [{
      name: "lookup",
      description: "lookup",
      inputSchema: { type: "object" },
    }],
  })) events.push(event);

  assert.deepEqual(events, [
    { type: "text_delta", delta: "hel" },
    { type: "text_delta", delta: "lo" },
    { type: "tool_call", call: { id: "call-1", name: "lookup", arguments: { query: "x" } } },
    { type: "done" },
  ]);
  assert.equal(model.doStreamCalls.length, 1);
});

test("AI SDK client surfaces provider stream errors", async () => {
  const failure = new Error("provider failed");
  const model = new MockLanguageModelV4({
    doStream: {
      stream: simulateReadableStream({
        chunks: [
          { type: "stream-start", warnings: [] },
          { type: "error", error: failure },
        ],
      }),
    },
  });

  const consume = async () => {
    for await (const _event of new AiSdkModelClient(model).stream({
      systemPrompt: "",
      messages: [createMessage({ role: "user", content: "fail now" })],
      tools: [],
    })) {
      // Consume until the adapter throws.
    }
  };
  await assert.rejects(consume(), failure);
});

test("AI SDK client surfaces an abort event instead of emitting done", async () => {
  const model = new MockLanguageModelV4({
    doStream: {
      stream: simulateReadableStream({
        chunks: [
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "text-1" },
          { type: "text-delta", id: "text-1", delta: "partial" },
          { type: "text-end", id: "text-1" },
          {
            type: "finish",
            finishReason: { unified: "stop", raw: "stop" },
            usage,
          },
        ],
      }),
    },
  });
  const controller = new AbortController();
  const events: ModelStreamEvent[] = [];
  const reason = new DOMException("cancel AI SDK stream", "AbortError");

  const consume = async () => {
    for await (const event of new AiSdkModelClient(model).stream({
      systemPrompt: "",
      messages: [createMessage({ role: "user", content: "cancel" })],
      tools: [],
      signal: controller.signal,
    })) {
      events.push(event);
      if (event.type === "text_delta") controller.abort(reason);
    }
  };
  await assert.rejects(consume(), reason);
  assert.deepEqual(events, [{ type: "text_delta", delta: "partial" }]);
});

test("OpenRouter AI SDK factory constructs a configured client", () => {
  const client = createAiSdkOpenRouterClient({
    apiKey: "test-key",
    model: "test/model",
    baseUrl: "https://example.invalid/v1",
    appName: "Runtime Tests",
    httpReferer: "https://example.invalid",
  });
  assert.ok(client instanceof AiSdkModelClient);
});
