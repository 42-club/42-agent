import assert from "node:assert/strict";
import test from "node:test";
import {
  AgentLoop,
  ConversationCompressionTool,
  InMemorySessionStore,
  type ModelClient,
  type ModelRequest,
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

test("budgets the complete frozen model request before sending it", async () => {
  const observed: ModelRequest[] = [];
  const model: ModelClient = {
    capabilities: { contextWindowTokens: 1_000 },
    estimateRequestTokens(request) {
      observed.push(request);
      const compressed = request.messages[0]?.metadata?.kind === "conversation_summary";
      return compressed ? 100 : 700;
    },
    async complete(request) {
      assert.equal(request, observed.at(-1));
      return { content: "budgeted" };
    },
  };
  const summarizer = new FakeModel([{ content: "safe summary" }]);
  const tools = new ToolRegistry();
  tools.register(new ConversationCompressionTool(summarizer, {
    retainRecent: 1,
    preserveRecentTokens: 0,
  }));
  tools.register({
    name: "lookup",
    description: "schema description ".repeat(30),
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "字段".repeat(40) } },
    },
    async execute() { return null; },
  });
  const store = new InMemorySessionStore();
  const session = await store.getOrCreate("complete-budget");
  session.messages.push(
    createMessage({ role: "user", content: "old" }),
    createMessage({
      role: "assistant",
      content: "",
      metadata: {
        toolCalls: [{ id: "old-call", name: "lookup", arguments: { query: "参数".repeat(50) } }],
      },
    }),
    createMessage({
      role: "tool",
      name: "lookup",
      toolCallId: "old-call",
      content: JSON.stringify({ value: "old result" }),
    }),
    createMessage({ role: "user", content: "recent" }),
  );

  const loop = new AgentLoop({
    model,
    tools,
    sessionStore: store,
    requestApproval: async () => false,
  });
  assert.equal(await loop.runTurn({
    sessionId: session.id,
    userInput: "now",
    promptInjections: ["系统约束".repeat(50)],
  }), "budgeted");

  assert.equal(observed.length, 2);
  assert.match(observed[0]?.systemPrompt ?? "", /系统约束/);
  assert.match(observed[0]?.tools.find((tool) => tool.name === "lookup")?.description ?? "", /schema/);
  const oldCall = observed[0]?.messages[1]?.metadata?.toolCalls as
    | Array<{ arguments: { query: string } }>
    | undefined;
  assert.match(oldCall?.[0]?.arguments.query ?? "", /参数/);
  assert.equal(observed[1]?.messages[0]?.role, "user");
  assert.equal(observed[1]?.messages[0]?.metadata?.kind, "conversation_summary");
});

test("CJK system prompts participate in the default context-window budget", async () => {
  let summaries = 0;
  const model: ModelClient = {
    capabilities: { contextWindowTokens: 3_500 },
    async complete() { return { content: "done" }; },
  };
  const summarizer: ModelClient = {
    async complete() {
      summaries += 1;
      return { content: "summary" };
    },
  };
  const tools = new ToolRegistry();
  tools.register(new ConversationCompressionTool(summarizer, {
    retainRecent: 1,
    preserveRecentTokens: 0,
  }));
  const store = new InMemorySessionStore();
  const session = await store.getOrCreate("cjk-budget");
  session.messages.push(
    createMessage({ role: "user", content: "old question" }),
    createMessage({ role: "assistant", content: "old answer" }),
  );
  const loop = new AgentLoop({
    model,
    tools,
    sessionStore: store,
    requestApproval: async () => false,
  });

  assert.equal(await loop.runTurn({
    sessionId: session.id,
    userInput: "继续",
    promptInjections: ["中".repeat(700)],
  }), "done");
  assert.equal(summaries, 1);
});

test("rechecks the request budget after a tool adds a large result", async () => {
  let modelCalls = 0;
  let summaries = 0;
  const estimates: number[] = [];
  const model: ModelClient = {
    capabilities: { contextWindowTokens: 1_000 },
    estimateRequestTokens(request) {
      const estimate = request.messages.some((message) => message.role === "tool") ? 700 : 100;
      estimates.push(estimate);
      return estimate;
    },
    async complete(request) {
      modelCalls += 1;
      if (modelCalls === 1) {
        return { toolCalls: [{ id: "large-call", name: "large_result", arguments: {} }] };
      }
      assert.equal(request.messages[0]?.metadata?.kind, "conversation_summary");
      return { content: "after tool compression" };
    },
  };
  const summarizer: ModelClient = {
    async complete() {
      summaries += 1;
      return { content: "tool-round summary" };
    },
  };
  const tools = new ToolRegistry();
  tools.register(new ConversationCompressionTool(summarizer, {
    retainRecent: 0,
    preserveRecentTokens: 0,
  }));
  tools.register({
    name: "large_result",
    description: "Return a large result",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async execute() { return { value: "结果".repeat(400) }; },
  });
  const loop = new AgentLoop({
    model,
    tools,
    sessionStore: new InMemorySessionStore(),
    requestApproval: async () => false,
  });

  assert.equal(await loop.runTurn({ sessionId: "tool-budget", userInput: "go" }),
    "after tool compression");
  assert.equal(modelCalls, 2);
  assert.equal(summaries, 1);
  assert.deepEqual(estimates, [100, 700, 100]);
});

test("does not send a request that remains above the model input safety budget", async () => {
  let modelCalls = 0;
  const model: ModelClient = {
    capabilities: { contextWindowTokens: 100 },
    estimateRequestTokens() { return 101; },
    async complete() {
      modelCalls += 1;
      return { content: "must not be sent" };
    },
  };
  const tools = new ToolRegistry();
  tools.register(new ConversationCompressionTool(new FakeModel([]), {
    retainRecent: 0,
    preserveRecentTokens: 0,
  }));
  const loop = new AgentLoop({
    model,
    tools,
    sessionStore: new InMemorySessionStore(),
    requestApproval: async () => false,
  });

  await assert.rejects(
    loop.runTurn({ sessionId: "hard-limit", userInput: "only message" }),
    /exceeding the model input budget of 90/,
  );
  assert.equal(modelCalls, 0);
});

test("cancellation wins when a capability resolver ignores its signal", async () => {
  const controller = new AbortController();
  const reason = new DOMException("cancel capability lookup", "AbortError");
  let estimates = 0;
  let modelCalls = 0;
  const model: ModelClient = {
    async getCapabilities() {
      controller.abort(reason);
      return { contextWindowTokens: 1_000 };
    },
    estimateRequestTokens() {
      estimates += 1;
      return 10;
    },
    async complete() {
      modelCalls += 1;
      return { content: "must not run" };
    },
  };
  const loop = new AgentLoop({
    model,
    tools: new ToolRegistry(),
    sessionStore: new InMemorySessionStore(),
    requestApproval: async () => false,
  });

  await assert.rejects(loop.runTurn({
    sessionId: "cancel-capabilities",
    userInput: "go",
    signal: controller.signal,
  }), reason);
  assert.equal(estimates, 0);
  assert.equal(modelCalls, 0);
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
