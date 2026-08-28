import {
  AgentLoop,
  AgentRuntime,
  InMemorySessionStore,
  type ModelClient,
  ToolRegistry,
} from "../src/index.js";

const model: ModelClient = {
  async complete({ messages }) {
    return { content: `收到：${messages.at(-1)?.content ?? ""}` };
  },
};

const tools = new ToolRegistry();
const sessionStore = new InMemorySessionStore();

const loop = new AgentLoop({
  model,
  tools,
  sessionStore,
  requestApproval: async () => false,
});
const runtime = new AgentRuntime({ loop });

await runtime.createSession({ sessionId: "demo" });
const result = await runtime.prompt({
  sessionId: "demo",
  content: [{ type: "text", text: "你好" }],
});
console.log(result.content.map((part) => part.text).join(""));
