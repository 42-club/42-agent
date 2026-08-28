import assert from "node:assert/strict";
import test from "node:test";
import {
  AgentLoop,
  ConversationCompressionTool,
  InMemorySessionStore,
  type ModelClient,
  type ModelResponse,
  ToolRegistry,
  createMessage,
} from "../src/index.js";

class FakeModel implements ModelClient {
  readonly prompts: string[] = [];
  constructor(private readonly responses: ModelResponse[]) {}
  async complete({ systemPrompt }: Parameters<ModelClient["complete"]>[0]): Promise<ModelResponse> {
    this.prompts.push(systemPrompt);
    const response = this.responses.shift();
    if (!response) throw new Error("No fake response available");
    return response;
  }
}

test("runs a turn with external prompt injection", async () => {
  const model = new FakeModel([{ content: "hello" }]);
  const tools = new ToolRegistry();
  tools.register(new ConversationCompressionTool(new FakeModel([])));
  const store = new InMemorySessionStore();
  const loop = new AgentLoop({ model, tools, sessionStore: store, requestApproval: async () => true });
  const result = await loop.runTurn({
    sessionId: "s1",
    userInput: "hi",
    promptInjections: ["channel instruction"],
  });
  assert.equal(result, "hello");
  assert.match(model.prompts[0]!, /channel instruction/);
  assert.equal((await store.getOrCreate("s1")).messages.length, 2);
});

test("performs a tool round trip", async () => {
  const model = new FakeModel([
    { toolCalls: [{ id: "1", name: "compress_conversation", arguments: {} }] },
    { content: "done" },
  ]);
  const tools = new ToolRegistry();
  tools.register(new ConversationCompressionTool(new FakeModel([])));
  const loop = new AgentLoop({
    model,
    tools,
    sessionStore: new InMemorySessionStore(),
    requestApproval: async () => true,
  });
  assert.equal(await loop.runTurn({ sessionId: "s", userInput: "go" }), "done");
});

test("automatically compresses at the configured token budget", async () => {
  const model = new FakeModel([{ content: "after compression" }]);
  const summarizer = new FakeModel([{ content: "summary" }]);
  const tools = new ToolRegistry();
  tools.register(new ConversationCompressionTool(summarizer, { preserveRecentTokens: 5 }));
  const store = new InMemorySessionStore();
  const session = await store.getOrCreate("s");
  session.messages = Array.from({ length: 99 }, (_, index) =>
    createMessage({ role: "user", content: String(index) }),
  );
  const loop = new AgentLoop({ model, tools, sessionStore: store, requestApproval: async () => true, config: { compressionThresholdTokens: 1 } });
  await loop.runTurn({ sessionId: "s", userInput: "100" });
  const messages = (await store.getOrCreate("s")).messages;
  assert.equal(messages[0]?.metadata?.kind, "conversation_summary");
  assert.equal(messages[0]?.metadata?.sourceCount, 80);
  assert.equal(messages.length, 22);
});

test("compression is optional and respects the active tool selection", async () => {
  let summaries = 0;
  const model = new FakeModel([{ content: "without compression" }, { content: "still scoped" }]);
  const summarizer: ModelClient = {
    async complete() {
      summaries += 1;
      return { content: "summary" };
    },
  };
  const tools = new ToolRegistry();
  tools.register(new ConversationCompressionTool(summarizer, { preserveRecentTokens: 1 }));
  tools.register({
    name: "echo",
    description: "No-op capability",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async execute() { return null; },
  });
  const store = new InMemorySessionStore();
  const loop = new AgentLoop({
    model,
    tools,
    sessionStore: store,
    requestApproval: async () => false,
    config: { compressionThresholdTokens: 1 },
  });

  assert.equal(await loop.runTurn({
    sessionId: "scoped-compression",
    userInput: "first",
    tools: ["echo"],
  }), "without compression");
  assert.equal(await loop.runTurn({
    sessionId: "scoped-compression",
    userInput: "second",
    tools: ["echo"],
  }), "still scoped");
  assert.equal(summaries, 0);
});

test("model requests cannot mutate canonical messages or Tool definitions", async () => {
  const store = new InMemorySessionStore();
  const tools = new ToolRegistry();
  tools.register({
    name: "safe",
    description: "safe",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async execute() { return null; },
  });
  const model: ModelClient = {
    async complete(request) {
      assert.throws(() => {
        (request.messages as unknown as Array<{ content: string }>)[0]!.content = "provider mutation";
      }, TypeError);
      assert.throws(() => {
        request.tools[0]!.inputSchema.additionalProperties = true;
      }, TypeError);
      return { content: "done" };
    },
  };
  const loop = new AgentLoop({
    model,
    tools,
    sessionStore: store,
    requestApproval: async () => false,
  });

  assert.equal(await loop.runTurn({ sessionId: "provider-isolation", userInput: "original" }), "done");
  assert.equal((await store.get("provider-isolation"))?.messages[0]?.content, "original");
  assert.equal(tools.get("safe").inputSchema.additionalProperties, false);
});
