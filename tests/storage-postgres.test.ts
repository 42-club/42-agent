import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";
import {
  migratePostgresSchema,
  openSessionStore,
  PostgresSessionStore,
  type ManagedSessionStore,
} from "../src/storage/index.js";
import {
  defineSessionStoreContract,
  type SessionStoreContractFixture,
} from "./session-store-contract.js";

const postgresUrl = process.env.TEST_POSTGRES_URL;

if (postgresUrl) {
  defineSessionStoreContract({
    name: "PostgreSQL",
    async createFixture() {
      const namespace = `contract-${randomUUID()}`;
      let store = await openSessionStore({
        namespace,
        postgres: { connectionString: postgresUrl, schemaMode: "migrate" },
      });
      let open = true;
      return {
        store,
        async reopen() {
          if (open) await store.close();
          store = await openSessionStore({
            namespace,
            postgres: { connectionString: postgresUrl },
          });
          open = true;
          return store;
        },
        async close() {
          if (open) {
            await store.close();
            open = false;
          }
          const cleanup = new Pool({ connectionString: postgresUrl, max: 1 });
          try {
            await cleanup.query(
              "DELETE FROM agent_runtime.sessions WHERE namespace = $1",
              [namespace],
            );
          } finally {
            await cleanup.end();
          }
        },
      } satisfies SessionStoreContractFixture;
    },
  });
}

test("PostgreSQL Store preserves the SessionStore transaction contract", {
  skip: postgresUrl ? false : "set TEST_POSTGRES_URL to run PostgreSQL integration tests",
}, async () => {
  assert.ok(postgresUrl);
  const namespace = `integration-${randomUUID()}`;
  const otherNamespace = `integration-${randomUUID()}`;
  const sessionId = `session-${randomUUID()}`;
  const stores: ManagedSessionStore[] = [];
  const observer = new Pool({ connectionString: postgresUrl, max: 1 });
  try {
    await migratePostgresSchema({ profile: "postgres", connectionString: postgresUrl });
    const ownershipColumn = await observer.query<{
      data_type: string;
      is_nullable: string;
    }>(
      `SELECT data_type, is_nullable
       FROM information_schema.columns
       WHERE table_schema = 'agent_runtime'
         AND table_name = 'sessions'
         AND column_name = 'ownership_json'`,
    );
    assert.deepEqual(ownershipColumn.rows, [{ data_type: "jsonb", is_nullable: "YES" }]);
    const ownershipMigration = await observer.query<{ name: string }>(
      "SELECT name FROM agent_runtime.schema_migrations WHERE version = 2",
    );
    assert.equal(ownershipMigration.rows[0]?.name, "protected_session_ownership");
    const store = await openSessionStore({
      namespace,
      postgres: { connectionString: postgresUrl },
    });
    stores.push(store);
    assert.ok(store instanceof PostgresSessionStore);
    assert.equal(store.profile, "postgres");

    const session = await store.create(sessionId, { owner: "test" });
    session.messages.push({
      role: "user",
      content: "hello",
      metadata: Object.fromEntries([
        ["e\u0301", "decomposed"],
        ["é", "composed"],
        ["z", 1],
        ["a", 2],
      ]),
      createdAt: "2026-01-01T08:00:00.000+08:00",
    });
    session.runState = {
      id: "run-1",
      status: "running",
      phase: "tools",
      round: 1,
      startedAt: "2026-01-01T08:00:00.000+08:00",
      updatedAt: "2026-01-01T08:00:01.000+08:00",
      toolCalls: [{
        id: "call-1",
        name: "lookup",
        arguments: { q: "value" },
        status: "completed",
        result: { ok: true },
      }],
    };
    await store.save(session);
    session.messages.push({ role: "assistant", content: "world" });
    await store.save(session);

    const restored = await store.get(sessionId);
    assert.equal(restored?.version, 2);
    assert.deepEqual(restored?.messages.map((message) => message.content), ["hello", "world"]);
    assert.equal(restored?.messages[0]?.createdAt, "2026-01-01T08:00:00.000+08:00");
    assert.deepEqual(restored?.runState?.toolCalls[0]?.result, { ok: true });
    assert.equal(restored?.messages[0]?.metadata?.["e\u0301"], "decomposed");
    assert.equal(restored?.messages[0]?.metadata?.["é"], "composed");
    assert.equal(restored?.runState?.startedAt, "2026-01-01T08:00:00.000+08:00");
    const checkpoint = await observer.query<{ last_checkpoint_id: string | null }>(
      `SELECT last_checkpoint_id FROM agent_runtime.sessions
       WHERE namespace = $1 AND id = $2`,
      [namespace, sessionId],
    );
    assert.match(checkpoint.rows[0]?.last_checkpoint_id ?? "", /^[0-9a-f-]{36}$/);

    restored!.messages[0]!.content = "edited";
    await assert.rejects(store.save(restored!), { name: "MessageHistoryRewriteRequiredError" });
    await store.save(restored!, { rewriteMessages: true });
    assert.equal((await store.get(sessionId))?.messages[0]?.content, "edited");

    const beforeRollback = await store.get(sessionId);
    assert.ok(beforeRollback);
    beforeRollback.messages.push({ role: "assistant", content: "must roll back" });
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    beforeRollback.metadata = circular;
    await assert.rejects(store.save(beforeRollback), TypeError);
    const afterRollback = await store.get(sessionId);
    assert.equal(afterRollback?.version, beforeRollback.version);
    assert.equal(afterRollback?.messages.some((message) => message.content === "must roll back"), false);

    const nulSession = await store.create(`nul-data-${randomUUID()}`);
    nulSession.messages.push({ role: "user", content: "before\0after" });
    await assert.rejects(store.save(nulSession), { name: "PostgresSessionDataError" });
    assert.equal(nulSession.version, 0);
    assert.deepEqual((await store.get(nulSession.id))?.messages, []);
    await store.delete(nulSession.id);

    const malformedUnicode = await store.create(`malformed-data-${randomUUID()}`);
    malformedUnicode.messages.push({ role: "user", content: "before\ud800after" });
    await assert.rejects(store.save(malformedUnicode), { name: "PostgresSessionDataError" });
    assert.deepEqual((await store.get(malformedUnicode.id))?.messages, []);
    await store.delete(malformedUnicode.id);

    const left = await store.get(sessionId);
    const right = await store.get(sessionId);
    assert.ok(left && right);
    left.messages.push({ role: "assistant", content: "left" });
    right.messages.push({ role: "assistant", content: "right" });
    const competing = await Promise.allSettled([store.save(left), store.save(right)]);
    assert.equal(competing.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = competing.find((result) => result.status === "rejected");
    assert.equal(rejected?.status, "rejected");
    if (rejected?.status === "rejected") {
      assert.equal((rejected.reason as Error).name, "SessionVersionConflictError");
    }

    const isolated = await openSessionStore({
      namespace: otherNamespace,
      supabase: { databaseUrl: postgresUrl, ssl: false },
    });
    stores.push(isolated);
    assert.ok(isolated instanceof PostgresSessionStore);
    assert.equal(isolated.profile, "supabase");
    assert.equal((await isolated.create(sessionId)).version, 0);
    assert.equal((await store.get(sessionId))?.metadata.owner, "test");

    const late = await store.get(sessionId);
    assert.ok(late);
    assert.equal(await store.delete(sessionId), true);
    late.messages.push({ role: "user", content: "late" });
    await assert.rejects(store.save(late), { name: "SessionVersionConflictError" });
    assert.equal(await store.get(sessionId), undefined);
    await isolated.delete(sessionId);
  } finally {
    await Promise.allSettled(stores.map(async (store) => store.close()));
    await observer.end();
  }
});

test("PostgreSQL startup rejects migration checksum drift and future versions", {
  skip: postgresUrl ? false : "set TEST_POSTGRES_URL to run PostgreSQL integration tests",
}, async () => {
  assert.ok(postgresUrl);
  const admin = new Pool({ connectionString: postgresUrl, max: 1 });
  try {
    const current = await admin.query<{ name: string; checksum: string }>(
      "SELECT name, checksum FROM agent_runtime.schema_migrations WHERE version = 1",
    );
    const migration = current.rows[0];
    assert.ok(migration);
    try {
      await admin.query(
        "UPDATE agent_runtime.schema_migrations SET checksum = 'tampered' WHERE version = 1",
      );
      await assert.rejects(openSessionStore({
        namespace: `checksum-${randomUUID()}`,
        postgres: { connectionString: postgresUrl },
      }), { name: "PostgresSchemaVersionError" });
    } finally {
      await admin.query(
        "UPDATE agent_runtime.schema_migrations SET name = $1, checksum = $2 WHERE version = 1",
        [migration.name, migration.checksum],
      );
    }

    try {
      await admin.query(
        `INSERT INTO agent_runtime.schema_migrations(version, name, checksum)
         VALUES (999, 'future', 'future')`,
      );
      await assert.rejects(openSessionStore({
        namespace: `future-${randomUUID()}`,
        postgres: { connectionString: postgresUrl },
      }), { name: "PostgresSchemaVersionError" });
    } finally {
      await admin.query(
        `DELETE FROM agent_runtime.schema_migrations
         WHERE version = 999 AND name = 'future' AND checksum = 'future'`,
      );
    }
  } finally {
    await admin.end();
  }
});

test("PostgreSQL readiness rejects runtime roles missing any documented table privilege", {
  skip: postgresUrl ? false : "set TEST_POSTGRES_URL to run PostgreSQL integration tests",
}, async () => {
  assert.ok(postgresUrl);
  const admin = new Pool({ connectionString: postgresUrl, max: 1 });
  const role = `agent_runtime_readiness_${randomUUID().replaceAll("-", "")}`;
  const quotedRole = quoteIdentifier(role);
  let currentUser = "";
  let roleCreated = false;
  let store: ManagedSessionStore | undefined;
  try {
    await migratePostgresSchema({ profile: "postgres", connectionString: postgresUrl });
    const identity = await admin.query<{ current_user: string }>("SELECT current_user");
    currentUser = identity.rows[0]!.current_user;
    await admin.query(`CREATE ROLE ${quotedRole}`);
    roleCreated = true;
    await admin.query(`GRANT ${quotedRole} TO ${quoteIdentifier(currentUser)}`);
    await admin.query(`GRANT USAGE ON SCHEMA agent_runtime TO ${quotedRole}`);
    await admin.query(`GRANT SELECT ON agent_runtime.schema_migrations TO ${quotedRole}`);

    const runtimeUrl = new URL(postgresUrl);
    const existingOptions = runtimeUrl.searchParams.get("options");
    runtimeUrl.searchParams.set(
      "options",
      [existingOptions, `-c role=${role}`].filter(Boolean).join(" "),
    );
    await assert.rejects(openSessionStore({
      namespace: `privilege-${randomUUID()}`,
      postgres: { connectionString: runtimeUrl.toString() },
    }), {
      name: "PostgresSchemaPermissionError",
      message: /INSERT, UPDATE, DELETE on agent_runtime\.sessions/,
    });

    await admin.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON
         agent_runtime.sessions, agent_runtime.messages,
         agent_runtime.runs, agent_runtime.tool_calls TO ${quotedRole}`,
    );
    store = await openSessionStore({
      namespace: `privilege-${randomUUID()}`,
      postgres: { connectionString: runtimeUrl.toString() },
    });
    const session = await store.create("ready");
    assert.equal(await store.delete(session.id), true);
  } finally {
    await store?.close();
    if (roleCreated) {
      await admin.query(`DROP OWNED BY ${quotedRole}`);
      if (currentUser) {
        await admin.query(`REVOKE ${quotedRole} FROM ${quoteIdentifier(currentUser)}`);
      }
      await admin.query(`DROP ROLE ${quotedRole}`);
    }
    await admin.end();
  }
});

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
