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

test("SQLite getOrCreate converges when two store instances race", async () => {
  const directory = await mkdtemp(join(tmpdir(), "42-agent-sqlite-create-race-"));
  const filename = join(directory, "runtime.sqlite");
  const first = new SqliteSessionStore(filename);
  const second = new SqliteSessionStore(filename);
  try {
    const sessions = await Promise.all([
      first.getOrCreate("shared"),
      second.getOrCreate("shared"),
    ]);
    assert.deepEqual(sessions.map((session) => session.id), ["shared", "shared"]);
  } finally {
    first.close();
    second.close();
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

    const messageCount = observer.prepare(
      "SELECT COUNT(*) AS count FROM messages WHERE session_id = ?",
    ).get(session.id) as { count: number } | undefined;
    const toolStatus = observer.prepare(
      "SELECT status FROM tool_calls WHERE run_id = ? AND id = ?",
    ).get("run-incremental", "call-1") as { status: string } | undefined;
    assert.equal(messageCount?.count, 2);
    assert.equal(toolStatus?.status, "completed");
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
    await assert.rejects(store.save(session), { name: "MessageHistoryRewriteRequiredError" });
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

test("SQLite requires rewriteMessages for existing message edits", async () => {
  const directory = await mkdtemp(join(tmpdir(), "42-agent-sqlite-edit-"));
  const filename = join(directory, "runtime.sqlite");
  const store = new SqliteSessionStore(filename);
  try {
    const session = await store.create("edit");
    session.messages.push(createMessage({ role: "user", content: "original" }));
    await store.save(session);
    session.messages[0]!.content = "edited";

    await assert.rejects(store.save(session), { name: "MessageHistoryRewriteRequiredError" });
    await store.save(session, { rewriteMessages: true });

    const reopened = new SqliteSessionStore(filename);
    try {
      assert.equal((await reopened.get(session.id))?.messages[0]?.content, "edited");
    } finally {
      reopened.close();
    }
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("SQLite rejects late saves after deletion", async () => {
  const directory = await mkdtemp(join(tmpdir(), "42-agent-sqlite-delete-"));
  const filename = join(directory, "runtime.sqlite");
  try {
    const store = new SqliteSessionStore(filename);
    const session = await store.create("deleted");
    assert.equal(await store.delete(session.id), true);
    session.messages.push(createMessage({ role: "user", content: "late" }));
    await assert.rejects(store.save(session), { name: "SessionVersionConflictError" });
    assert.equal(await store.get(session.id), undefined);
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("SQLite restores the explicitly current run when timestamps tie", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-sqlite-current-run-"));
  const filename = join(directory, "sessions.sqlite");
  const timestamp = new Date().toISOString();
  const store = new SqliteSessionStore(filename);
  try {
    const session = await store.create("same-timestamp");
    session.runState = {
      id: "older-run",
      status: "completed",
      phase: "idle",
      round: 0,
      startedAt: timestamp,
      updatedAt: timestamp,
      toolCalls: [],
    };
    await store.save(session);
    session.runState = {
      id: "current-run",
      status: "running",
      phase: "tools",
      round: 1,
      startedAt: timestamp,
      updatedAt: timestamp,
      toolCalls: [],
    };
    await store.save(session);
  } finally {
    store.close();
  }

  const reopened = new SqliteSessionStore(filename);
  try {
    assert.equal((await reopened.get("same-timestamp"))?.runState?.id, "current-run");
    assert.equal((await reopened.get("same-timestamp"))?.runState?.status, "running");
  } finally {
    reopened.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("SQLite rejects non-well-formed Unicode session IDs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-sqlite-session-id-"));
  const store = new SqliteSessionStore(join(directory, "sessions.sqlite"));
  try {
    await assert.rejects(store.create("\ud800"), { name: "InvalidSessionIdError" });
    await assert.rejects(store.get("\ud801"), { name: "InvalidSessionIdError" });
    assert.ok(await store.create("\ufffd"));
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("SQLite executes and restores 1,000 conversation turns with tool calls", async () => {
  const directory = await mkdtemp(join(tmpdir(), "42-agent-sqlite-long-chat-"));
  const filename = join(directory, "runtime.sqlite");
  const turnCount = 1_000;
  try {
    const store = new SqliteSessionStore(filename);
    let toolExecutions = 0;
    const model: ModelClient = {
      async complete({ messages }) {
        const latest = messages.at(-1);
        if (latest?.role === "user") {
          const currentTurn = (messages.length + 3) / 4;
          assert.equal(latest.content, `turn-${currentTurn}`);
          return {
            content: "",
            toolCalls: [{
              id: `call-${currentTurn}`,
              name: "echo_turn",
              arguments: { turn: currentTurn },
            }],
          };
        }
        assert.equal(latest?.role, "tool");
        const result = JSON.parse(latest.content) as { turn: number };
        return { content: `ack-${result.turn}` };
      },
    };
    const tools = new ToolRegistry();
    tools.register(new ConversationCompressionTool(model));
    tools.register({
      name: "echo_turn",
      description: "Return the supplied conversation turn.",
      inputSchema: {
        type: "object",
        properties: { turn: { type: "integer", minimum: 1 } },
        required: ["turn"],
        additionalProperties: false,
      },
      async execute(arguments_) {
        toolExecutions += 1;
        return { turn: Number(arguments_.turn) };
      },
    });
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
    assert.equal(toolExecutions, turnCount);
    store.close();

    const restoredStore = new SqliteSessionStore(filename);
    const restored = await restoredStore.getOrCreate("long-chat");
    assert.equal(restored.messages.length, turnCount * 4);
    for (let turn = 1; turn <= turnCount; turn += 1) {
      const offset = (turn - 1) * 4;
      assert.equal(restored.messages[offset]?.content, `turn-${turn}`);
      assert.equal(
        (restored.messages[offset + 1]?.metadata?.toolCalls as Array<{ id: string }>)[0]?.id,
        `call-${turn}`,
      );
      assert.deepEqual(JSON.parse(restored.messages[offset + 2]?.content ?? ""), { turn });
      assert.equal(restored.messages[offset + 3]?.content, `ack-${turn}`);
    }
    assert.equal(restored.runState?.status, "completed");
    assert.equal(restored.version, turnCount * 8);
    restoredStore.close();

    const observer = new DatabaseSync(filename);
    const runCount = observer.prepare("SELECT COUNT(*) AS count FROM runs").get() as {
      count: number;
    } | undefined;
    const toolCount = observer.prepare("SELECT COUNT(*) AS count FROM tool_calls").get() as {
      count: number;
    } | undefined;
    assert.equal(runCount?.count, turnCount);
    assert.equal(
      toolCount?.count,
      turnCount,
    );
    observer.close();
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
