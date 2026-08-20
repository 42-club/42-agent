import { AgentLoop, InMemorySessionStore, type ModelClient, ToolRegistry } from "../src/index.js";
import { BashTool, ConversationCompressionTool } from "../src/index.js";

const model: ModelClient = {
  async complete({ messages }) {
    return { content: `收到：${messages.at(-1)?.content ?? ""}` };
  },
};

const tools = new ToolRegistry();
tools.register(new ConversationCompressionTool(model));
tools.register(new BashTool({ defaultCwd: process.cwd() }));

const loop = new AgentLoop({
  model,
  tools,
  sessionStore: new InMemorySessionStore(),
  requestApproval: async () => false,
});

console.log(await loop.runTurn({ sessionId: "demo", userInput: "你好" }));
