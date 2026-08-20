import assert from "node:assert/strict";
import test from "node:test";
import {
  AgentLoop,
  ConversationCompressionTool,
  InMemorySessionStore,
  ToolRegistry,
  createAgentRuntimeHttpServer,
  streamRuntimeTurn,
  type ModelClient,
} from "../src/index.js";

test("different channels can share one canonical server-side session", async () => {
  const model: ModelClient = {
    async complete({ messages }) {
      return { content: `messages=${messages.length}` };
    },
  };
  const tools = new ToolRegistry();
  tools.register(new ConversationCompressionTool(model));
  const sessions = new InMemorySessionStore();
  const loop = new AgentLoop({
    model,
    tools,
    sessionStore: sessions,
    requestApproval: async () => false,
  });
  const runtime = createAgentRuntimeHttpServer(loop, { port: 0 });
  const address = await runtime.listen();
  const url = `http://${address.host}:${address.port}`;
  try {
    const cliItems = [];
    for await (const item of streamRuntimeTurn(url, {
      sessionId: "same-session",
      userInput: "from cli",
    })) cliItems.push(item);
    const webItems = [];
    for await (const item of streamRuntimeTurn(url, {
      sessionId: "same-session",
      userInput: "from web",
    })) webItems.push(item);

    assert.equal(cliItems.find((item) => item.type === "result")?.content, "messages=1");
    assert.equal(webItems.find((item) => item.type === "result")?.content, "messages=3");
    assert.equal((await sessions.getOrCreate("same-session")).messages.length, 4);
  } finally {
    await runtime.close();
  }
});
