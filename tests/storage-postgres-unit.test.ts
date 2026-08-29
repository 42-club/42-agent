import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { Pool } from "pg";
import { SessionSaveOutcomeUnknownError } from "../src/index.js";
import { PostgresSessionStore } from "../src/storage/index.js";

test("uncertain COMMIT releases a one-client pool before checkpoint verification", async () => {
  const fixture = uncertainCommitPool(true);
  let observedIdleError: Error | undefined;
  const store = new PostgresSessionStore({
    connectionString: "postgresql://runtime@localhost/agent",
    namespace: "uncertain-commit",
    maxConnections: 1,
    pool: fixture.pool,
    onPoolError(error) {
      observedIdleError = error;
      throw new Error("observer failures are isolated");
    },
  });
  const idleError = new Error("idle connection failed");
  fixture.events.emit("error", idleError);
  assert.equal(observedIdleError, idleError);

  const session = { id: "session", version: 0, messages: [], metadata: {} };
  await store.save(session);
  assert.equal(session.version, 1);
  assert.equal(fixture.releaseDestroyed, true);
  assert.equal(fixture.verifiedAfterRelease, true);
  assert.ok(fixture.clientQueries.every((query) => query.connection === "transaction-client"));

  const firstClose = store.close();
  assert.equal(store.close(), firstClose);
  await firstClose;
  assert.equal(fixture.events.listenerCount("error"), 0);
});

test("unverified COMMIT is surfaced as unknown and is never retried", async () => {
  const fixture = uncertainCommitPool(false);
  const store = new PostgresSessionStore({
    connectionString: "postgresql://runtime@localhost/agent",
    namespace: "unknown-commit",
    maxConnections: 1,
    pool: fixture.pool,
  });
  const session = { id: "session", version: 0, messages: [], metadata: {} };
  await assert.rejects(store.save(session), (error) => {
    assert.equal((error as Error).name, "PostgresTransactionOutcomeUnknownError");
    assert.ok(error instanceof SessionSaveOutcomeUnknownError);
    return true;
  });
  assert.equal(session.version, 0);
  assert.equal(fixture.verificationCount, 1);
  assert.equal(fixture.releaseDestroyed, true);
  await store.close();
});

function uncertainCommitPool(confirmCheckpoint: boolean): {
  pool: Pool;
  events: EventEmitter;
  clientQueries: Array<{ connection: "transaction-client"; sql: string }>;
  readonly releaseDestroyed: boolean;
  readonly verifiedAfterRelease: boolean;
  readonly verificationCount: number;
} {
  const events = new EventEmitter();
  const clientQueries: Array<{ connection: "transaction-client"; sql: string }> = [];
  let checkpointId = "";
  let nextVersion = 0;
  let released = false;
  let releaseDestroyed = false;
  let verifiedAfterRelease = false;
  let verificationCount = 0;

  const client = {
    async query(sql: string, values: unknown[] = []) {
      clientQueries.push({ connection: "transaction-client", sql });
      if (sql === "BEGIN") return result();
      if (sql.includes("SELECT version") && sql.includes("FOR UPDATE")) {
        return result([{ version: 0 }]);
      }
      if (sql.includes("FROM agent_runtime.messages")) return result([]);
      if (sql.includes("UPDATE agent_runtime.sessions")) {
        nextVersion = Number(values[2]);
        checkpointId = String(values[5]);
        return result([], 1);
      }
      if (sql === "COMMIT") throw new Error("connection lost after COMMIT was sent");
      if (sql === "ROLLBACK") return result();
      throw new Error(`Unexpected transaction query: ${sql}`);
    },
    release(destroy?: boolean) {
      released = true;
      releaseDestroyed = destroy === true;
    },
  };

  const fakePool = Object.assign(events, {
    async connect() {
      return client;
    },
    async query(sql: string) {
      if (!sql.includes("last_checkpoint_id")) throw new Error(`Unexpected pool query: ${sql}`);
      verificationCount += 1;
      verifiedAfterRelease = released;
      return confirmCheckpoint
        ? result([{ version: nextVersion, last_checkpoint_id: checkpointId }])
        : result([{ version: 0, last_checkpoint_id: null }]);
    },
    async end() {},
  }) as unknown as Pool;

  return {
    pool: fakePool,
    events,
    clientQueries,
    get releaseDestroyed() {
      return releaseDestroyed;
    },
    get verifiedAfterRelease() {
      return verifiedAfterRelease;
    },
    get verificationCount() {
      return verificationCount;
    },
  };
}

function result(rows: unknown[] = [], rowCount = rows.length): {
  rows: unknown[];
  rowCount: number;
} {
  return { rows, rowCount };
}
