import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "pg";
import {
  openSessionStore,
  resolveSessionDatabaseConfig,
  type SessionDatabaseConfig,
} from "../src/storage/index.js";
import { selectSessionDatabaseConfig } from "../src/storage/config.js";
import { createPostgresMigrationPoolConfig } from "../src/storage/postgres-migrations.js";
import {
  createPostgresPoolConfig,
  PostgresSessionStore,
} from "../src/storage/postgres-session-store.js";

const postgres = "postgresql://runtime:secret@localhost:5432/agent";
const supabase = "postgresql://runtime:secret@db.example.supabase.co:5432/postgres";

test("database auto-selection uses postgres, supabase, sqlite priority", () => {
  const all = resolveSessionDatabaseConfig({
    namespace: "agent-a",
    postgres: { connectionString: postgres },
    supabase: { databaseUrl: supabase },
    sqlite: { filename: "agent.sqlite" },
  });
  assert.deepEqual(all, {
    profile: "postgres",
    engine: "postgres",
    namespace: "agent-a",
    schemaMode: "check",
    ignoredProfiles: ["supabase", "sqlite"],
  });

  const withoutPostgres = resolveSessionDatabaseConfig({
    namespace: "agent-a",
    supabase: { databaseUrl: supabase },
    sqlite: { filename: "agent.sqlite" },
  });
  assert.equal(withoutPostgres.profile, "supabase");
  assert.equal(withoutPostgres.engine, "postgres");
  assert.equal(withoutPostgres.ssl, true);
  assert.equal(JSON.stringify(withoutPostgres).includes("secret"), false);

  assert.equal(resolveSessionDatabaseConfig({
    namespace: "agent-a",
    supabase: { databaseUrl: supabase, ssl: false },
  }).ssl, false);
  assert.equal(resolveSessionDatabaseConfig({
    namespace: "agent-a",
    supabase: { databaseUrl: `${supabase}?sslmode=verify-full` },
  }).ssl, undefined);
  assert.equal(resolveSessionDatabaseConfig({
    namespace: "agent-a",
    supabase: { databaseUrl: `${supabase}?ssl=0` },
  }).ssl, undefined);

  assert.equal(resolveSessionDatabaseConfig({
    namespace: "agent-a",
    sqlite: { filename: "agent.sqlite" },
  }).profile, "sqlite");
});

test("explicit database mode selects a complete requested profile", () => {
  const resolved = resolveSessionDatabaseConfig({
    mode: "sqlite",
    namespace: "local",
    postgres: { connectionString: postgres },
    sqlite: { filename: "local.sqlite" },
  });
  assert.equal(resolved.profile, "sqlite");
  assert.deepEqual(resolved.ignoredProfiles, ["postgres"]);
});

test("Supabase runtime and migration URLs resolve TLS independently", () => {
  const runtimeHasMode = selectSessionDatabaseConfig({
    namespace: "tls",
    supabase: {
      databaseUrl: `${supabase}?sslmode=verify-full`,
      migrationUrl: "postgresql://migrate:secret@db.example.supabase.co:5432/postgres",
    },
  }).selected;
  assert.equal(runtimeHasMode.profile, "supabase");
  if (runtimeHasMode.profile === "supabase") {
    assert.equal(runtimeHasMode.ssl, undefined);
    assert.equal(runtimeHasMode.migrationSsl, true);
  }

  const migrationHasMode = selectSessionDatabaseConfig({
    namespace: "tls",
    supabase: {
      databaseUrl: supabase,
      migrationUrl: "postgresql://migrate:secret@localhost:5432/postgres?sslmode=disable",
    },
  }).selected;
  assert.equal(migrationHasMode.profile, "supabase");
  if (migrationHasMode.profile === "supabase") {
    assert.equal(migrationHasMode.ssl, true);
    assert.equal(migrationHasMode.migrationSsl, undefined);
  }

  const explicitPlaintext = selectSessionDatabaseConfig({
    namespace: "tls",
    supabase: {
      databaseUrl: supabase,
      migrationUrl: "postgresql://migrate:secret@localhost:5432/postgres",
      ssl: false,
    },
  }).selected;
  assert.equal(explicitPlaintext.profile, "supabase");
  if (explicitPlaintext.profile === "supabase") {
    assert.equal(explicitPlaintext.ssl, false);
    assert.equal(explicitPlaintext.migrationSsl, false);
  }

  const defaultTlsClient = new Client(createPostgresPoolConfig({
    connectionString: supabase,
    namespace: "tls",
    profile: "supabase",
  }));
  assert.equal(defaultTlsClient.ssl, true);
  const urlPlaintextClient = new Client(createPostgresPoolConfig({
    connectionString: `${supabase}?sslmode=disable`,
    namespace: "tls",
  }));
  assert.equal(urlPlaintextClient.ssl, false);
  const urlSslZeroClient = new Client(createPostgresPoolConfig({
    connectionString: `${supabase}?ssl=0`,
    namespace: "tls",
  }));
  assert.equal(urlSslZeroClient.ssl, false);
  assert.throws(() => createPostgresPoolConfig({
    connectionString: `${supabase}?sslmode=disable`,
    namespace: "tls",
    profile: "supabase",
    ssl: true,
  }), { name: "DatabaseConfigurationError" });
  assert.throws(() => new PostgresSessionStore({
    connectionString: `${supabase}?ssl=0`,
    namespace: "tls",
    profile: "supabase",
    ssl: true,
  }), { name: "DatabaseConfigurationError" });
});

test("standalone schema migration config is profile-aware and TLS-safe", () => {
  const supabaseDefault = createPostgresMigrationPoolConfig({
    profile: "supabase",
    databaseUrl: supabase,
  });
  assert.equal(new Client(supabaseDefault).ssl, true);
  assert.equal(supabaseDefault.max, 1);

  const urlControlled = createPostgresMigrationPoolConfig({
    profile: "supabase",
    databaseUrl: `${supabase}?sslmode=disable`,
  });
  assert.equal(new Client(urlControlled).ssl, false);

  const postgresDefault = createPostgresMigrationPoolConfig({
    profile: "postgres",
    connectionString: postgres,
  });
  assert.equal(Object.hasOwn(postgresDefault, "ssl"), false);

  assert.throws(() => createPostgresMigrationPoolConfig({
    profile: "supabase",
    databaseUrl: `${supabase}?ssl=0`,
    ssl: true,
  }), { name: "DatabaseConfigurationError" });
  assert.throws(() => createPostgresMigrationPoolConfig({
    profile: "supabase",
    databaseUrl: "https://example.com/not-postgres",
  }), { name: "DatabaseConfigurationError" });
  assert.throws(() => createPostgresMigrationPoolConfig({
    profile: "postgres",
    connectionString: postgres,
    connectionTimeoutMillis: 0,
  }), { name: "DatabaseConfigurationError" });
});

test("database config rejects missing, partial, and illegal profiles before selection", () => {
  const invalid: unknown[] = [
    { namespace: "agent" },
    { namespace: "", sqlite: { filename: "x" } },
    { namespace: "agent", postgres: {} },
    { namespace: "agent", postgres: { connectionString: "https://example.com/db" } },
    { namespace: "agent", supabase: { databaseUrl: "" } },
    { namespace: "agent", supabase: { databaseUrl: supabase, ssl: "yes" } },
    {
      namespace: "agent",
      supabase: { databaseUrl: `${supabase}?sslmode=disable`, ssl: true },
    },
    {
      namespace: "agent",
      supabase: { databaseUrl: `${supabase}?ssl=0`, ssl: true },
    },
    {
      namespace: "agent",
      supabase: {
        databaseUrl: supabase,
        migrationUrl: `${supabase}?sslmode=disable`,
        ssl: true,
      },
    },
    { namespace: "agent", sqlite: { filename: " " } },
    { namespace: "agent", mode: "postgres", sqlite: { filename: "x" } },
    {
      namespace: "agent",
      postgres: { connectionString: postgres },
      supabase: {},
    },
    {
      namespace: "agent",
      postgres: { connectionString: postgres, maxConnections: 0 },
    },
  ];
  for (const config of invalid) {
    assert.throws(
      () => resolveSessionDatabaseConfig(config as SessionDatabaseConfig),
      { name: "DatabaseConfigurationError" },
    );
  }
});

test("SQLite factory returns a managed Store with idempotent close", async () => {
  const directory = await mkdtemp(join(tmpdir(), "42-agent-managed-sqlite-"));
  const filename = join(directory, "sessions.sqlite");
  try {
    const store = await openSessionStore({ namespace: "local", sqlite: { filename } });
    assert.equal(store.profile, "sqlite");
    assert.equal(store.engine, "sqlite");
    const session = await store.create("managed");
    session.messages.push({ role: "user", content: "hello" });
    await store.save(session);
    const firstClose = store.close();
    assert.equal(store.close(), firstClose);
    await firstClose;
    await assert.rejects(store.get("managed"), { name: "ManagedSessionStoreClosedError" });

    const reopened = await openSessionStore({ namespace: "local", sqlite: { filename } });
    assert.equal((await reopened.get("managed"))?.messages[0]?.content, "hello");
    await reopened.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("selected PostgreSQL connection failure never falls back to SQLite", async () => {
  const directory = await mkdtemp(join(tmpdir(), "42-agent-no-fallback-"));
  const filename = join(directory, "fallback.sqlite");
  try {
    await assert.rejects(openSessionStore({
      namespace: "no-fallback",
      postgres: {
        connectionString: "postgresql://invalid:invalid@127.0.0.1:1/missing",
        connectionTimeoutMillis: 100,
      },
      sqlite: { filename },
    }));
    await assert.rejects(
      import("node:fs/promises").then(({ access }) => access(filename)),
      { code: "ENOENT" },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
