import assert from "node:assert/strict";
import test from "node:test";
import {
  InMemorySessionStore,
  createMessage,
  snapshotSessionOwnership,
} from "../src/index.js";

test("in-memory store rejects late saves after deletion", async () => {
  const store = new InMemorySessionStore();
  const session = await store.create("deleted");
  await store.delete(session.id);
  session.messages.push(createMessage({ role: "user", content: "late" }));

  await assert.rejects(store.save(session), { name: "SessionVersionConflictError" });
  assert.equal(await store.get(session.id), undefined);
});

test("session stores reject non-well-formed Unicode IDs", async () => {
  const store = new InMemorySessionStore();
  await assert.rejects(store.create("\ud800"), { name: "InvalidSessionIdError" });
  await assert.rejects(store.get("\ud801"), { name: "InvalidSessionIdError" });
  assert.ok(await store.create("\ufffd"));
});

test("in-memory store requires rewriteMessages for existing message edits", async () => {
  const store = new InMemorySessionStore();
  const session = await store.create("rewrite");
  session.messages.push(createMessage({ role: "user", content: "original" }));
  await store.save(session);
  session.messages[0]!.content = "edited";

  await assert.rejects(store.save(session), { name: "MessageHistoryRewriteRequiredError" });
  await store.save(session, { rewriteMessages: true });
  assert.equal((await store.get(session.id))?.messages[0]?.content, "edited");
});

test("Session ownership accepts only an exact detached version 1 envelope", () => {
  const source = { version: 1 as const, kind: "adapter", value: "owner" };
  const snapshot = snapshotSessionOwnership(source);
  assert.deepEqual(snapshot, source);
  assert.notEqual(snapshot, source);

  const invalid: unknown[] = [
    null,
    {},
    { version: 2, kind: "adapter", value: "owner" },
    { version: 1, kind: "", value: "owner" },
    { version: 1, kind: "adapter", value: "" },
    { version: 1, kind: "adapter\0", value: "owner" },
    { version: 1, kind: "adapter", value: "owner\ud800" },
    { version: 1, kind: "adapter", value: "owner", unexpected: true },
  ];
  for (const value of invalid) {
    assert.throws(() => snapshotSessionOwnership(value), {
      name: "InvalidSessionOwnershipError",
    });
  }
});
