import assert from "node:assert/strict";
import test from "node:test";
import {
  AgentLoop,
  ChannelRuntime,
  ConversationCompressionTool,
  InMemorySessionStore,
  type ChannelAdapter,
  type ChannelInboundMessage,
  type ChannelOutboundMessage,
  type ModelClient,
  ToolRegistry,
} from "../src/index.js";

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

test("channel stays stateless and delegates history to AgentLoop", async () => {
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
  const runtime = new ChannelRuntime(loop, channel);

  await runtime.handle({ conversation: "c1", sender: "u1", text: "first" });
  await runtime.handle({ conversation: "c1", sender: "u1", text: "second" });

  assert.deepEqual(
    channel.sent.map((message) => message.text),
    ["history=1", "history=3"],
  );
  assert.equal((await sessions.getOrCreate("test:c1")).messages.length, 4);
});
