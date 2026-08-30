import assert from "node:assert/strict";
import test from "node:test";
import {
  AgentLoop,
  AgentRuntime,
  InMemorySessionStore,
  type ModelClient,
  ToolRegistry,
} from "../src/index.js";
import {
  ChannelRuntime,
  type ChannelAdapter,
  type ChannelInboundMessage,
  type ChannelOutboundMessage,
} from "../src/channel/index.js";
import { ConversationCompressionTool } from "../src/tools/index.js";

interface TestEvent {
  conversation: string;
  sender: string;
  text: string;
}

class TestChannel implements ChannelAdapter<TestEvent> {
  readonly name = "test";
  readonly sent: ChannelOutboundMessage[] = [];

  async normalize(event: TestEvent): Promise<ChannelInboundMessage> {
    return {
      channel: this.name,
      conversationId: event.conversation,
      senderId: event.sender,
      text: event.text,
    };
  }

  async send(message: ChannelOutboundMessage): Promise<void> {
    this.sent.push(message);
  }

  promptInjection(): string {
    return "这是测试 Channel。";
  }
}

test("channel stays stateless and delegates lifecycle to AgentRuntime", async () => {
  const model: ModelClient = {
    async complete({ messages, systemPrompt }) {
      assert.match(systemPrompt, /测试 Channel/);
      return { content: `history=${messages.length}` };
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
  const channel = new TestChannel();
  const agentRuntime = new AgentRuntime({ loop, sessionStore: sessions, tools });
  const runtime = new ChannelRuntime(agentRuntime, channel);

  await runtime.handle({ conversation: "c1", sender: "u1", text: "first" });
  await runtime.handle({ conversation: "c1", sender: "u1", text: "second" });

  assert.deepEqual(
    channel.sent.map((message) => message.text),
    ["history=1", "history=3"],
  );
  assert.equal((await sessions.getOrCreate("test:c1")).messages.length, 4);
});
