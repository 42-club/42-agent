import assert from "node:assert/strict";
import test from "node:test";
import {
  AgentLoop, ConversationCompressionTool, InMemorySessionStore, ToolRegistry,
  type ModelClient, type Tool,
} from "../src/index.js";

test("one tool batch runs concurrently and returns results in call order", async () => {
  let modelCalls = 0;
  const observed: string[] = [];
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
      return input.value;
    },
  };
  const tools = new ToolRegistry();
  tools.register(new ConversationCompressionTool(model));
  tools.register(delay);
  const loop = new AgentLoop({ model, tools, sessionStore: new InMemorySessionStore(), requestApproval: async () => false });
  assert.equal(await loop.runTurn({ sessionId: "parallel", userInput: "go" }), "done");
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
