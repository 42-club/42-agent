import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  AgentLoop,
  ConversationCompressionTool,
  FileSessionStore,
  SqliteSessionStore,
  ToolRegistry,
  createMessage,
  type ModelClient,
  type Session,
} from "../src/index.js";

test("compression preserves complete assistant/tool batches and forwards cancellation", async () => {
  let receivedSignal: AbortSignal | undefined;
  const summarizer: ModelClient = {
    async complete(request) {
      receivedSignal = request.signal;
      return { content: "summary" };
    },
  };
  const session: Session = {
    id: "compression",
    metadata: {},
    messages: [
      createMessage({ role: "user", content: "old question" }),
      createMessage({ role: "assistant", content: "old answer" }),
      createMessage({
        role: "assistant",
        content: "",
        metadata: { toolCalls: [{ id: "call-1", name: "lookup", arguments: {} }] },
      }),
      createMessage({ role: "tool", name: "lookup", toolCallId: "call-1", content: "{}" }),
      createMessage({ role: "user", content: "recent question" }),
      createMessage({ role: "assistant", content: "recent answer" }),
    ],
  };
  const controller = new AbortController();
  const tool = new ConversationCompressionTool(summarizer, {
    batchSize: 5,
    retainRecent: 3,
    preserveRecentTokens: 1,
  });

  const result = await tool.execute({}, {
    session,
    mutableSession: session,
    requestApproval: async () => false,
    signal: controller.signal,
  }) as { summarizedCount: number };

  assert.equal(result.summarizedCount, 2);
  assert.equal(receivedSignal, controller.signal);
  assert.equal(session.messages[1]?.role, "assistant");
  assert.equal(session.messages[2]?.role, "tool");
  assert.equal(session.messages[2]?.toolCallId, "call-1");
});

test("model-requested compression retains its trailing unmaterialized tool batch", async () => {
  const summarizer: ModelClient = {
    async complete() { return { content: "old context" }; },
  };
  const session: Session = {
    id: "trailing-compression-call",
    metadata: {},
    messages: [
      createMessage({ role: "user", content: "old question" }),
      createMessage({ role: "assistant", content: "old answer" }),
      createMessage({
        role: "assistant",
        content: "",
        metadata: {
          toolCalls: [{ id: "compress-now", name: "compress_conversation", arguments: {} }],
        },
      }),
    ],
  };
  const tool = new ConversationCompressionTool(summarizer, {
    batchSize: 10,
    retainRecent: 0,
    preserveRecentTokens: 0,
  });

  await tool.execute({}, {
    session,
    mutableSession: session,
    requestApproval: async () => false,
  });
  assert.deepEqual(session.messages.map((message) => message.role), ["system", "assistant"]);
  assert.equal(
    (session.messages[1]?.metadata?.toolCalls as Array<{ id: string }> | undefined)?.[0]?.id,
    "compress-now",
  );
});

test("compression rejects invalid sizing options at construction", () => {
  const summarizer: ModelClient = { async complete() { return { content: "summary" }; } };
  assert.throws(
    () => new ConversationCompressionTool(summarizer, { batchSize: -1, retainRecent: -2 }),
    /batchSize must be a positive integer/,
  );
  assert.throws(
    () => new ConversationCompressionTool(summarizer, { preserveRecentTokens: -1 }),
    /preserveRecentTokens must be non-negative/,
  );
  assert.throws(
    () => new ConversationCompressionTool(summarizer, { targetRatio: 2 }),
    /targetRatio must be greater than 0 and at most 1/,
  );
});

for (const [name, content] of [
  ["missing", undefined],
  ["blank", " \n\t "],
] as const) {
  test(`compression preserves the complete history when summary content is ${name}`, async () => {
    const summarizer: ModelClient = {
      async complete() {
        return { content };
      },
    };
    const session: Session = {
      id: `compression-${name}`,
      metadata: { source: "test" },
      messages: [
        createMessage({ role: "user", content: "old question" }),
        createMessage({ role: "assistant", content: "old answer" }),
        createMessage({ role: "user", content: "recent question" }),
        createMessage({ role: "assistant", content: "recent answer" }),
      ],
    };
    const originalMessages = structuredClone(session.messages);
    const tool = new ConversationCompressionTool(summarizer, {
      batchSize: 3,
      retainRecent: 1,
      preserveRecentTokens: 1,
    });

    await assert.rejects(
      tool.execute({}, {
        session,
        mutableSession: session,
        requestApproval: async () => false,
      }),
      /summarizer returned empty content/,
    );

    assert.deepEqual(session.messages, originalMessages);
  });
}

for (const storeKind of ["file", "sqlite"] as const) {
  test(`model-requested compression persists a completed run in the ${storeKind} store`, async () => {
    const directory = await mkdtemp(join(tmpdir(), `42-agent-compression-${storeKind}-`));
    const path = storeKind === "file" ? directory : join(directory, "sessions.sqlite");
    const store = storeKind === "file"
      ? new FileSessionStore(path)
      : new SqliteSessionStore(path);
    try {
      const session = await store.create("explicit-compression");
      session.messages.push(...Array.from({ length: 8 }, (_, index) => createMessage({
        role: index % 2 === 0 ? "user" : "assistant",
        content: `old-${index}`,
      })));
      await store.save(session);

      let modelCalls = 0;
      const model: ModelClient = {
        async complete() {
          modelCalls += 1;
          return modelCalls === 1
            ? {
              toolCalls: [{
                id: "compress-now",
                name: "compress_conversation",
                arguments: {},
              }],
            }
            : { content: "done" };
        },
      };
      const summarizer: ModelClient = {
        async complete() { return { content: "durable summary" }; },
      };
      const tools = new ToolRegistry();
      tools.register(new ConversationCompressionTool(summarizer, {
        batchSize: 6,
        retainRecent: 2,
        preserveRecentTokens: 1,
      }));
      const loop = new AgentLoop({
        model,
        tools,
        sessionStore: store,
        requestApproval: async () => false,
      });

      assert.equal(await loop.runTurn({
        sessionId: "explicit-compression",
        userInput: "compress",
      }), "done");
      if (store instanceof SqliteSessionStore) store.close();

      const reopened = storeKind === "file"
        ? new FileSessionStore(path)
        : new SqliteSessionStore(path);
      try {
        const restored = await reopened.get("explicit-compression");
        assert.equal(restored?.runState?.status, "completed");
        assert.equal(restored?.messages[0]?.metadata?.kind, "conversation_summary");
        assert.equal(restored?.messages.some((message) => (
          message.toolCallId === "compress-now"
        )), true);
        assert.equal(restored?.messages.at(-1)?.content, "done");
      } finally {
        if (reopened instanceof SqliteSessionStore) reopened.close();
      }
    } finally {
      if (store instanceof SqliteSessionStore) {
        try { store.close(); } catch { /* already closed */ }
      }
      await rm(directory, { recursive: true, force: true });
    }
  });
}
