import assert from "node:assert/strict";
import test from "node:test";
import { OpenRouterModelClient } from "../src/provider/index.js";
import {
  estimateTokenUpperBound,
  type ModelRequest,
  type ModelStreamEvent,
} from "../src/index.js";

const request: ModelRequest = {
  systemPrompt: "system", messages: [{ role: "user", content: "hello" }],
  tools: [{ name: "lookup", description: "lookup", inputSchema: { type: "object" } }],
};

test("OpenRouter defaults to Opus 4.6 and normalizes tool calls", async () => {
  let payload: any;
  const client = new OpenRouterModelClient({ apiKey: "test-key", fetch: async (_input, init) => {
    payload = JSON.parse(String(init?.body));
    return Response.json({ choices: [{ message: { content: "", tool_calls: [{ id: "t1", type: "function", function: { name: "lookup", arguments: '{"q":"x"}' } }] } }] });
  } });
  const response = await client.complete(request);
  assert.equal(payload.model, "anthropic/claude-opus-4.6");
  assert.equal(payload.messages[0].role, "system");
  assert.deepEqual(response.toolCalls?.[0]?.arguments, { q: "x" });
});

test("OpenRouter resolves and caches the selected model's real limits", async () => {
  const urls: string[] = [];
  const client = new OpenRouterModelClient({
    apiKey: "test-key",
    model: "vendor/model:free",
    baseUrl: "https://router.invalid/api/v1/",
    fetch: async (input) => {
      urls.push(String(input));
      return Response.json({
        data: {
          context_length: 32_768,
          top_provider: { max_completion_tokens: 8_192 },
        },
      });
    },
  });

  assert.equal(client.capabilities, undefined);
  assert.deepEqual(await client.getCapabilities(), {
    contextWindowTokens: 32_768,
    maxOutputTokens: 8_192,
  });
  assert.deepEqual(await client.getCapabilities(), {
    contextWindowTokens: 32_768,
    maxOutputTokens: 8_192,
  });
  assert.deepEqual(client.capabilities, {
    contextWindowTokens: 32_768,
    maxOutputTokens: 8_192,
  });
  assert.deepEqual(urls, ["https://router.invalid/api/v1/model/vendor/model%3Afree"]);
});

test("explicit OpenRouter limits skip model metadata lookup", async () => {
  let fetches = 0;
  const client = new OpenRouterModelClient({
    apiKey: "test-key",
    contextWindowTokens: 16_384,
    maxOutputTokens: 4_096,
    fetch: async () => {
      fetches += 1;
      throw new Error("metadata lookup should be skipped");
    },
  });

  assert.deepEqual(await client.getCapabilities(), {
    contextWindowTokens: 16_384,
    maxOutputTokens: 4_096,
  });
  assert.equal(fetches, 0);
});

test("cancelled OpenRouter metadata is not cached and can be retried", async () => {
  const controller = new AbortController();
  const reason = new DOMException("cancel metadata", "AbortError");
  let fetches = 0;
  const client = new OpenRouterModelClient({
    apiKey: "test-key",
    model: "test/model",
    fetch: async () => {
      fetches += 1;
      if (fetches === 1) controller.abort(reason);
      return Response.json({ data: { context_length: 8_192 } });
    },
  });

  await assert.rejects(client.getCapabilities(controller.signal), reason);
  assert.deepEqual(await client.getCapabilities(), { contextWindowTokens: 8_192 });
  assert.equal(fetches, 2);
});

test("OpenRouter rejects inconsistent configured model limits", () => {
  assert.throws(() => new OpenRouterModelClient({
    apiKey: "test-key",
    contextWindowTokens: 4_096,
    maxOutputTokens: 8_192,
  }), /maxOutputTokens cannot exceed contextWindowTokens/);
});

test("OpenRouter estimates the same serialized payload that it sends", async () => {
  let payload: unknown;
  const client = new OpenRouterModelClient({
    apiKey: "test-key",
    contextWindowTokens: 10_000,
    fetch: async (_input, init) => {
      payload = JSON.parse(String(init?.body));
      return Response.json({ choices: [{ message: { content: "done" } }] });
    },
  });
  const toolRequest: ModelRequest = {
    systemPrompt: "系统规则",
    messages: [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "",
        metadata: {
          toolCalls: [{ id: "call-1", name: "lookup", arguments: { q: "参数".repeat(20) } }],
        },
      },
      { role: "tool", name: "lookup", toolCallId: "call-1", content: '{"value":1}' },
    ],
    tools: [{
      name: "lookup",
      description: "lookup values",
      inputSchema: { type: "object", properties: { q: { type: "string" } } },
    }],
  };
  const estimate = client.estimateRequestTokens(toolRequest);

  await client.complete(toolRequest);
  assert.equal(estimate, estimateTokenUpperBound(JSON.stringify(payload)));
});

test("OpenRouter streaming assembles fragmented tool calls", async () => {
  const sse = [
    'data: {"choices":[{"delta":{"content":"Hi "}}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"t1","function":{"name":"look","arguments":"{\\"q\\":"}}]}}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"up","arguments":"\\"x\\"}"}}]}}]}',
    "data: [DONE]", "",
  ].join("\n");
  const client = new OpenRouterModelClient({ apiKey: "test-key", fetch: async () => new Response(sse, { status: 200 }) });
  const events: ModelStreamEvent[] = [];
  for await (const event of client.stream(request)) events.push(event);
  assert.deepEqual(events[0], { type: "text_delta", delta: "Hi " });
  assert.deepEqual(events[1], { type: "tool_call", call: { id: "t1", name: "lookup", arguments: { q: "x" } } });
  assert.deepEqual(events[2], { type: "done" });
});

test("OpenRouter streaming treats DONE as terminal even when the body stays open", async () => {
  let streamController!: ReadableStreamDefaultController<Uint8Array>;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
      controller.enqueue(new TextEncoder().encode([
        'data: {"choices":[{"delta":{"content":"Hi"}}]}',
        "data: [DONE]",
        "",
      ].join("\n")));
    },
    cancel() {
      cancelled = true;
    },
  });
  const response = new Response(body);
  const client = new OpenRouterModelClient({
    apiKey: "test-key",
    fetch: async () => response,
  });
  const iterator = client.stream(request)[Symbol.asyncIterator]();
  assert.deepEqual(await iterator.next(), {
    done: false,
    value: { type: "text_delta", delta: "Hi" },
  });

  let timeout: NodeJS.Timeout | undefined;
  try {
    const terminal = await Promise.race([
      iterator.next(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("DONE did not terminate the stream")), 250);
      }),
    ]);
    assert.deepEqual(terminal, { done: false, value: { type: "done" } });
    assert.equal(cancelled, true);
    assert.equal(response.body?.locked, false);
  } finally {
    if (timeout) clearTimeout(timeout);
    if (!cancelled) streamController.close();
    await iterator.return?.();
  }
});

test("OpenRouter streaming cancels and unlocks the body on IteratorClose", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(
        'data: {"choices":[{"delta":{"content":"partial"}}]}\n',
      ));
    },
    cancel() {
      cancelled = true;
    },
  });
  const response = new Response(body);
  const client = new OpenRouterModelClient({ apiKey: "test-key", fetch: async () => response });
  const iterator = client.stream(request)[Symbol.asyncIterator]();

  assert.deepEqual(await iterator.next(), {
    done: false,
    value: { type: "text_delta", delta: "partial" },
  });
  await iterator.return?.();
  assert.equal(cancelled, true);
  assert.equal(response.body?.locked, false);
});

test("OpenRouter streaming cancels and unlocks the body after a parse failure", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("data: {invalid json}\n"));
    },
    cancel() {
      cancelled = true;
    },
  });
  const response = new Response(body);
  const client = new OpenRouterModelClient({ apiKey: "test-key", fetch: async () => response });

  await assert.rejects(async () => {
    for await (const _event of client.stream(request)) {
      // The first malformed event fails before anything is yielded.
    }
  }, SyntaxError);
  assert.equal(cancelled, true);
  assert.equal(response.body?.locked, false);
});

test("OpenRouter streaming rejects a truncated EOF without DONE", async () => {
  const client = new OpenRouterModelClient({
    apiKey: "test-key",
    fetch: async () => new Response(
      'data: {"choices":[{"delta":{"content":"partial"}}]}\n',
      { status: 200 },
    ),
  });
  const events: ModelStreamEvent[] = [];

  await assert.rejects(async () => {
    for await (const event of client.stream(request)) events.push(event);
  }, /ended before the \[DONE\] marker/);
  assert.deepEqual(events, [{ type: "text_delta", delta: "partial" }]);
});
