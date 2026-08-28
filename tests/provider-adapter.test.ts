import assert from "node:assert/strict";
import test from "node:test";
import {
  AdaptedModelClient,
  AgentLoop,
  InMemorySessionStore,
  ToolRegistry,
  type ModelRequest,
} from "../src/index.js";

test("a non-streaming adapted provider keeps AgentLoop retry semantics", async () => {
  let attempts = 0;
  const client = new AdaptedModelClient<{}, { answer: string }, never>(
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
