import assert from "node:assert/strict";
import test from "node:test";
import type { RunState, SessionStore } from "../src/session.js";

export interface SessionStoreContractFixture {
  /** The initially opened store. */
  readonly store: SessionStore;
  /** Close/release the current store as needed and open the same logical backing store again. */
  reopen(): Promise<SessionStore>;
  /** Close any open store and remove fixture-owned resources. */
  close(): Promise<void>;
}

export interface SessionStoreContractAdapter {
  readonly name: string;
  createFixture(): Promise<SessionStoreContractFixture>;
}

export function defineSessionStoreContract(adapter: SessionStoreContractAdapter): void {
  test(`${adapter.name} SessionStore: create, get, getOrCreate, and duplicate create`, async () => {
    await withFixture(adapter, async ({ store }) => {
      assert.equal(await store.get("missing"), undefined);

      const created = await store.create("created", { owner: "runtime", nested: { value: 42 } });
      assert.equal(created.id, "created");
      assert.equal(created.version, 0);
      assert.deepEqual(created.messages, []);
      assert.deepEqual(created.metadata, { owner: "runtime", nested: { value: 42 } });

      const fetched = await store.get("created");
      assert.equal(fetched?.id, "created");
      assert.deepEqual(fetched?.metadata, created.metadata);

      const existing = await store.getOrCreate("created");
      assert.equal(existing.id, "created");
      assert.deepEqual(existing.metadata, created.metadata);

      await assert.rejects(store.create("created"), { name: "SessionAlreadyExistsError" });

      const generated = await store.getOrCreate("generated");
      assert.equal(generated.id, "generated");
      assert.equal(generated.version, 0);
      assert.deepEqual(generated.messages, []);
      assert.deepEqual(generated.metadata, {});
    });
  });

  test(`${adapter.name} SessionStore: round-trips canonical session data after reopen`, async () => {
    await withFixture(adapter, async (fixture) => {
      const session = await fixture.store.create("round-trip", {
        owner: "运行时",
        flags: [true, false],
      });
      session.messages.push({
        role: "tool",
        content: "结果：你好，世界 🌍",
        name: "lookup",
        toolCallId: "call-round-trip",
        metadata: { nested: { count: 2 }, tags: ["一", "two"] },
        createdAt: "2026-08-29T01:02:03.000Z",
      });

      await fixture.store.save(session);
      assert.equal(session.version, 1);

      const reopened = await fixture.reopen();
      const restored = await reopened.get("round-trip");
      assert.equal(restored?.version, 1);
      assert.deepEqual(asJson(restored?.metadata), asJson(session.metadata));
      assert.deepEqual(asJson(restored?.messages), asJson(session.messages));
    });
  });

  test(`${adapter.name} SessionStore: rejects stale saves without replacing current state`, async () => {
    await withFixture(adapter, async (fixture) => {
      const current = await fixture.store.create("stale-save", { revision: "initial" });
      const stale = structuredClone(current);

      current.metadata.revision = "current";
      current.messages.push({ role: "user", content: "current value" });
      await fixture.store.save(current);

      stale.metadata.revision = "stale";
      stale.messages.push({ role: "user", content: "stale value" });
      await assert.rejects(fixture.store.save(stale), {
        name: "SessionVersionConflictError",
      });
      assert.equal(stale.version, 0);

      const reopened = await fixture.reopen();
      const restored = await reopened.get("stale-save");
      assert.equal(restored?.version, 1);
      assert.equal(restored?.metadata.revision, "current");
      assert.deepEqual(restored?.messages.map(({ content }) => content), ["current value"]);
    });
  });

  test(`${adapter.name} SessionStore: deletion prevents a late save from reviving state`, async () => {
    await withFixture(adapter, async (fixture) => {
      const session = await fixture.store.create("deleted-late-save");
      assert.equal(await fixture.store.delete(session.id), true);
      assert.equal(await fixture.store.delete(session.id), false);

      session.messages.push({ role: "user", content: "must not be revived" });
      await assert.rejects(fixture.store.save(session), {
        name: "SessionVersionConflictError",
      });

      const reopened = await fixture.reopen();
      assert.equal(await reopened.get(session.id), undefined);
    });
  });

  test(`${adapter.name} SessionStore: appends by default and rewrites only when requested`, async () => {
    await withFixture(adapter, async (fixture) => {
      const session = await fixture.store.create("message-history");
      session.messages.push({ role: "user", content: "first" });
      await fixture.store.save(session);

      session.messages.push({ role: "assistant", content: "second" });
      await fixture.store.save(session);
      assert.equal(session.version, 2);

      session.messages[0]!.content = "edited first";
      await assert.rejects(fixture.store.save(session), {
        name: "MessageHistoryRewriteRequiredError",
      });
      assert.equal(session.version, 2);

      await fixture.store.save(session, { rewriteMessages: true });
      assert.equal(session.version, 3);

      const reopened = await fixture.reopen();
      const restored = await reopened.get(session.id);
      assert.deepEqual(restored?.messages.map(({ content }) => content), [
        "edited first",
        "second",
      ]);
    });
  });

  test(`${adapter.name} SessionStore: preserves valid Unicode and rejects ill-formed IDs`, async () => {
    await withFixture(adapter, async (fixture) => {
      for (const invalidId of ["", "\ud800", "\udfff"]) {
        await assert.rejects(fixture.store.create(invalidId), { name: "InvalidSessionIdError" });
        await assert.rejects(fixture.store.get(invalidId), { name: "InvalidSessionIdError" });
        await assert.rejects(fixture.store.getOrCreate(invalidId), {
          name: "InvalidSessionIdError",
        });
        await assert.rejects(fixture.store.delete(invalidId), { name: "InvalidSessionIdError" });
      }

      const sessionId = "会话/😀/�/مرحبا";
      const session = await fixture.store.create(sessionId, { label: "多语言 🧪" });
      session.messages.push({ role: "user", content: "こんにちは — Здравствуйте" });
      await fixture.store.save(session);

      const reopened = await fixture.reopen();
      const restored = await reopened.get(sessionId);
      assert.equal(restored?.id, sessionId);
      assert.equal(restored?.metadata.label, "多语言 🧪");
      assert.equal(restored?.messages[0]?.content, "こんにちは — Здравствуйте");
    });
  });

  test(`${adapter.name} SessionStore: restores the explicitly current run`, async () => {
    await withFixture(adapter, async (fixture) => {
      const session = await fixture.store.create("current-run");
      session.runState = runState("old-run", "completed", "2026-08-29T02:00:00.000Z");
      await fixture.store.save(session);

      const current = runState("new-run", "running", "2026-08-29T02:00:00.000Z");
      current.round = 3;
      current.phase = "tools";
      current.toolCalls = [{
        id: "call-current",
        name: "lookup",
        arguments: { query: "当前" },
        status: "completed",
        result: { answer: 42 },
      }];
      session.runState = current;
      await fixture.store.save(session);

      const reopened = await fixture.reopen();
      const restored = await reopened.get(session.id);
      assert.equal(restored?.runState?.id, "new-run");
      assert.equal(restored?.runState?.status, "running");
      assert.equal(restored?.runState?.round, 3);
      assert.equal(restored?.runState?.phase, "tools");
      assert.deepEqual(asJson(restored?.runState?.toolCalls), asJson(current.toolCalls));
    });
  });
}

async function withFixture(
  adapter: SessionStoreContractAdapter,
  run: (fixture: SessionStoreContractFixture) => Promise<void>,
): Promise<void> {
  const fixture = await adapter.createFixture();
  try {
    await run(fixture);
  } finally {
    await fixture.close();
  }
}

function runState(id: string, status: RunState["status"], timestamp: string): RunState {
  return {
    id,
    status,
    round: 0,
    phase: "idle",
    startedAt: timestamp,
    updatedAt: timestamp,
    toolCalls: [],
  };
}

function asJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}
