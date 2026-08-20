import assert from "node:assert/strict";
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
