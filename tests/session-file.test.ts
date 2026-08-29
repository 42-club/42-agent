import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  SessionAlreadyExistsError,
  createMessage,
  type Session,
} from "../src/index.js";
import { FileSessionStore } from "../src/storage/index.js";

test("File store persists sessions and advances their version on every save", async () => {
  await withStoreDirectory(async (directory) => {
    const store = new FileSessionStore(directory);
    const session = await store.create("normal", { owner: "runtime" });
    assert.equal(session.version, 0);

    session.messages.push(createMessage({ role: "user", content: "hello" }));
    await store.save(session);
    assert.equal(session.version, 1);

    session.messages.push(createMessage({ role: "assistant", content: "hi" }));
    await store.save(session);
    assert.equal(session.version, 2);

    const restored = await new FileSessionStore(directory).get("normal");
    assert.equal(restored?.version, 2);
    assert.deepEqual(restored?.metadata, { owner: "runtime" });
    assert.deepEqual(restored?.messages.map((message) => message.content), ["hello", "hi"]);
  });
});

test("File store serializes concurrent saves of the same live session", async () => {
  await withStoreDirectory(async (directory) => {
    const store = new FileSessionStore(directory);
    const session = await store.create("parallel-save");
    session.messages.push(createMessage({ role: "user", content: "checkpoint" }));

    const saveCount = 40;
    await Promise.all(Array.from({ length: saveCount }, async () => store.save(session)));

    assert.equal(session.version, saveCount);
    const restored = await new FileSessionStore(directory).get("parallel-save");
    assert.equal(restored?.version, saveCount);
    assert.equal(restored?.messages[0]?.content, "checkpoint");
    assert.deepEqual((await readdir(directory)).filter((name) => name.endsWith(".tmp")), []);
  });
});

test("File store permits exactly one concurrent create for a session", async () => {
  await withStoreDirectory(async (directory) => {
    const first = new FileSessionStore(directory);
    const second = new FileSessionStore(directory);
    const attempts = await Promise.allSettled([
      first.create("exclusive", { attempt: 1 }),
      second.create("exclusive", { attempt: 2 }),
      first.create("exclusive", { attempt: 3 }),
      second.create("exclusive", { attempt: 4 }),
    ]);

    const fulfilled = attempts.filter(
      (attempt): attempt is PromiseFulfilledResult<Session> => attempt.status === "fulfilled",
    );
    const rejected = attempts.filter(
      (attempt): attempt is PromiseRejectedResult => attempt.status === "rejected",
    );
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, attempts.length - 1);
    for (const attempt of rejected) {
      assert.ok(attempt.reason instanceof SessionAlreadyExistsError);
    }

    const restored = await new FileSessionStore(directory).get("exclusive");
    assert.deepEqual(restored?.metadata, fulfilled[0]?.value.metadata);
  });
});

test("File store rejects a late save instead of reviving a deleted session", async () => {
  await withStoreDirectory(async (directory) => {
    const store = new FileSessionStore(directory);
    const session = await store.create("deleted");
    assert.equal(await store.delete(session.id), true);

    session.messages.push(createMessage({ role: "user", content: "too late" }));
    await assert.rejects(store.save(session), { name: "SessionVersionConflictError" });
    assert.equal(await store.get(session.id), undefined);
    assert.deepEqual(await readdir(directory), []);
  });
});

test("File store rejects stale versions without replacing persisted state", async () => {
  await withStoreDirectory(async (directory) => {
    const store = new FileSessionStore(directory);
    const session = await store.create("versioned");
    const stale = structuredClone(session);

    session.messages.push(createMessage({ role: "user", content: "current" }));
    await store.save(session);
    stale.messages.push(createMessage({ role: "user", content: "stale" }));
    await assert.rejects(
      store.save(stale),
      /Session versioned version conflict: expected 0, found 1/,
    );

    const restored = await new FileSessionStore(directory).get("versioned");
    assert.equal(restored?.version, 1);
    assert.deepEqual(restored?.messages.map((message) => message.content), ["current"]);
  });
});

test("File store requires rewriteMessages for existing message edits", async () => {
  await withStoreDirectory(async (directory) => {
    const store = new FileSessionStore(directory);
    const session = await store.create("rewrite");
    session.messages.push(createMessage({ role: "user", content: "original" }));
    await store.save(session);
    session.messages[0]!.content = "edited";

    await assert.rejects(store.save(session), { name: "MessageHistoryRewriteRequiredError" });
    assert.equal((await store.get(session.id))?.messages[0]?.content, "original");
    await store.save(session, { rewriteMessages: true });
    const restored = await new FileSessionStore(directory).get(session.id);
    assert.equal(restored?.messages[0]?.content, "edited");
  });
});

test("File store rejects lossy Unicode IDs instead of aliasing sessions", async () => {
  await withStoreDirectory(async (directory) => {
    const store = new FileSessionStore(directory);
    await assert.rejects(store.create("\ud800", { owner: "first" }), {
      name: "InvalidSessionIdError",
    });
    await assert.rejects(store.get("\ud801"), { name: "InvalidSessionIdError" });
    const valid = await store.create("\ufffd", { owner: "valid" });
    assert.equal(valid.metadata.owner, "valid");
  });
});

test("File store encoding keeps IDs distinct on case-insensitive filesystems", async () => {
  await withStoreDirectory(async (directory) => {
    const store = new FileSessionStore(directory);
    const first = await store.create("aaa", { owner: "lowercase-path" });
    const second = await store.create("aaG", { owner: "uppercase-path" });
    assert.equal(first.id, "aaa");
    assert.equal(second.id, "aaG");
    assert.equal((await store.get("aaa"))?.metadata.owner, "lowercase-path");
    assert.equal((await store.get("aaG"))?.metadata.owner, "uppercase-path");
  });
});

test("File store accepts long IDs without exceeding filename component limits", async () => {
  await withStoreDirectory(async (directory) => {
    const store = new FileSessionStore(directory);
    const sessionId = `long-${"界".repeat(1_000)}`;
    await store.create(sessionId, { owner: "long-id" });
    assert.equal((await store.get(sessionId))?.metadata.owner, "long-id");
    assert.equal(await store.delete(sessionId), true);
  });
});

async function withStoreDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "42-agent-file-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
