import assert from "node:assert/strict";
import test from "node:test";
import { OpenRouterModelClient, type ModelRequest, type ModelStreamEvent } from "../src/index.js";

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
