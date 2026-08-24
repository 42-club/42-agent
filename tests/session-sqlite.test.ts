import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  AgentLoop,
  ConversationCompressionTool,
  SqliteSessionStore,
  ToolRegistry,
  createMessage,
  type ModelClient,
} from "../src/index.js";

test("SQLite persists messages, runs, and tool calls across store instances", async () => {
  const directory = await mkdtemp(join(tmpdir(), "42-agent-sqlite-"));
  const filename = join(directory, "runtime.sqlite");
  try {
    const first = new SqliteSessionStore(filename);
    const session = await first.getOrCreate("durable");
    session.messages.push(createMessage({ role: "user", content: "hello" }));
    session.runState = {
      id: "run-1", status: "running", phase: "tools", round: 1,
      startedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:01.000Z",
      toolCalls: [{ id: "call-1", name: "lookup", arguments: { q: "x" }, status: "completed", result: { ok: true } }],
    };
    await first.save(session);
    first.close();

    const second = new SqliteSessionStore(filename);
    const restored = await second.getOrCreate("durable");
    assert.equal(restored.messages[0]?.content, "hello");
    assert.equal(restored.runState?.toolCalls[0]?.status, "completed");
    assert.deepEqual(restored.runState?.toolCalls[0]?.result, { ok: true });
    second.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("SQLite appends messages and upserts tool calls without rewriting persisted rows", async () => {
  const directory = await mkdtemp(join(tmpdir(), "42-agent-sqlite-incremental-"));
  const filename = join(directory, "runtime.sqlite");
  try {
    const store = new SqliteSessionStore(filename);
    const session = await store.getOrCreate("incremental");
    session.messages.push(createMessage({ role: "user", content: "first" }));
    session.runState = {
      id: "run-incremental", status: "running", phase: "tools", round: 0,
      startedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:01.000Z",
      toolCalls: [{ id: "call-1", name: "lookup", arguments: {}, status: "running" }],
    };
    await store.save(session);

    const observer = new DatabaseSync(filename);
    observer.exec(`
      CREATE TRIGGER reject_message_rewrite BEFORE DELETE ON messages
      BEGIN SELECT RAISE(ABORT, 'message row was rewritten'); END;
      CREATE TRIGGER reject_message_update BEFORE UPDATE ON messages
      BEGIN SELECT RAISE(ABORT, 'message row was updated'); END;
      CREATE TRIGGER reject_tool_delete BEFORE DELETE ON tool_calls
      BEGIN SELECT RAISE(ABORT, 'tool row was deleted'); END;
    `);

    session.messages.push(createMessage({ role: "assistant", content: "second" }));
    session.runState.toolCalls[0]!.status = "completed";
    session.runState.toolCalls[0]!.result = { ok: true };
    await store.save(session);

    assert.equal(observer.prepare(
      "SELECT COUNT(*) AS count FROM messages WHERE session_id = ?",
    ).get(session.id)?.count, 2);
    assert.equal(observer.prepare(
      "SELECT status FROM tool_calls WHERE run_id = ? AND id = ?",
    ).get("run-incremental", "call-1")?.status, "completed");
    observer.close();
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("SQLite rewrites message history only when explicitly requested", async () => {
  const directory = await mkdtemp(join(tmpdir(), "42-agent-sqlite-rewrite-"));
  const filename = join(directory, "runtime.sqlite");
  try {
    const store = new SqliteSessionStore(filename);
    const session = await store.getOrCreate("rewrite");
    session.messages.push(
      createMessage({ role: "user", content: "old one" }),
      createMessage({ role: "assistant", content: "old two" }),
    );
    await store.save(session);

    session.messages = [createMessage({ role: "system", content: "summary" })];
    await assert.rejects(store.save(session), /shortened without rewriteMessages/);
    await store.save(session, { rewriteMessages: true });
    store.close();

    const restoredStore = new SqliteSessionStore(filename);
    const restored = await restoredStore.getOrCreate("rewrite");
    assert.deepEqual(restored.messages.map((message) => message.content), ["summary"]);
    restoredStore.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("SQLite executes and restores 1,000 consecutive conversation turns", async () => {
  const directory = await mkdtemp(join(tmpdir(), "42-agent-sqlite-long-chat-"));
  const filename = join(directory, "runtime.sqlite");
  const turnCount = 1_000;
  try {
    const store = new SqliteSessionStore(filename);
    const model: ModelClient = {
      async complete({ messages }) {
        const currentTurn = (messages.length + 1) / 2;
        const latest = messages.at(-1);
        assert.equal(latest?.role, "user");
        assert.equal(latest?.content, `turn-${currentTurn}`);
        return { content: `ack-${currentTurn}` };
      },
    };
    const tools = new ToolRegistry();
    tools.register(new ConversationCompressionTool(model));
    const loop = new AgentLoop({
      model,
      tools,
      sessionStore: store,
      requestApproval: async () => false,
    });

    for (let turn = 1; turn <= turnCount; turn += 1) {
      const response = await loop.runTurn({
        sessionId: "long-chat",
        userInput: `turn-${turn}`,
      });
      assert.equal(response, `ack-${turn}`);
    }
    store.close();

    const restoredStore = new SqliteSessionStore(filename);
    const restored = await restoredStore.getOrCreate("long-chat");
    assert.equal(restored.messages.length, turnCount * 2);
    for (let turn = 1; turn <= turnCount; turn += 1) {
      const offset = (turn - 1) * 2;
      assert.equal(restored.messages[offset]?.content, `turn-${turn}`);
      assert.equal(restored.messages[offset + 1]?.content, `ack-${turn}`);
    }
    assert.equal(restored.runState?.status, "completed");
    assert.equal(restored.version, turnCount * 3);
    restoredStore.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("turns are FIFO within one session while different sessions remain concurrent", async () => {
  let active = 0;
  let maximum = 0;
  const order: string[] = [];
  const releases = new Map<string, () => void>();
  const model: ModelClient = {
    async complete({ messages }) {
      const input = messages.at(-1)?.content ?? "";
      active += 1;
      maximum = Math.max(maximum, active);
      order.push(`start:${input}`);
      await new Promise<void>((resolve) => releases.set(input, resolve));
      order.push(`end:${input}`);
      active -= 1;
      return { content: input };
    },
  };
  const tools = new ToolRegistry();
  tools.register(new ConversationCompressionTool(model));
  const loop = new AgentLoop({ model, tools, sessionStore: new (await import("../src/index.js")).InMemorySessionStore(), requestApproval: async () => false });

  const a1 = loop.runTurn({ sessionId: "a", userInput: "a1" });
  const a2 = loop.runTurn({ sessionId: "a", userInput: "a2" });
  const b1 = loop.runTurn({ sessionId: "b", userInput: "b1" });
  await waitUntil(() => releases.has("a1") && releases.has("b1"));
  assert.equal(releases.has("a2"), false);
  releases.get("a1")!();
  await waitUntil(() => releases.has("a2"));
  releases.get("a2")!();
  releases.get("b1")!();
  await Promise.all([a1, a2, b1]);
  assert.ok(maximum >= 2);
  assert.ok(order.indexOf("end:a1") < order.indexOf("start:a2"));
});

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition not reached");
}
