import { createHash } from "node:crypto";
import { Pool, type PoolClient, type PoolConfig, type QueryResultRow } from "pg";
import { resolvePostgresPoolSsl } from "./postgres-tls.js";
import {
  DatabaseConfigurationError,
  type PostgresSchemaMigrationConfig,
} from "./types.js";

export const POSTGRES_SCHEMA = "agent_runtime";

const INITIAL_SCHEMA_SQL = `
CREATE TABLE agent_runtime.sessions (
  namespace text NOT NULL,
  id text NOT NULL,
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  metadata_json jsonb NOT NULL,
  current_run_id text,
  last_checkpoint_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (namespace, id)
);

CREATE TABLE agent_runtime.messages (
  namespace text NOT NULL,
  session_id text NOT NULL,
  sequence bigint NOT NULL CHECK (sequence >= 0),
  role text NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
  content text NOT NULL,
  name text,
  tool_call_id text,
  metadata_json jsonb,
  created_at text,
  PRIMARY KEY (namespace, session_id, sequence),
  FOREIGN KEY (namespace, session_id)
    REFERENCES agent_runtime.sessions(namespace, id) ON DELETE CASCADE
);

CREATE TABLE agent_runtime.runs (
  namespace text NOT NULL,
  session_id text NOT NULL,
  id text NOT NULL,
  status text NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'cancelled', 'interrupted')),
  phase text NOT NULL CHECK (phase IN ('model', 'tools', 'idle')),
  round integer NOT NULL CHECK (round >= 0),
  error text,
  started_at text NOT NULL,
  updated_at text NOT NULL,
  PRIMARY KEY (namespace, session_id, id),
  FOREIGN KEY (namespace, session_id)
    REFERENCES agent_runtime.sessions(namespace, id) ON DELETE CASCADE
);

CREATE INDEX runs_session_started
  ON agent_runtime.runs(namespace, session_id, started_at DESC);

CREATE TABLE agent_runtime.tool_calls (
  namespace text NOT NULL,
  session_id text NOT NULL,
  run_id text NOT NULL,
  id text NOT NULL,
  call_index integer NOT NULL CHECK (call_index >= 0),
  name text NOT NULL,
  arguments_json jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed', 'interrupted')),
  result_json jsonb,
  error text,
  PRIMARY KEY (namespace, session_id, run_id, id),
  UNIQUE (namespace, session_id, run_id, call_index),
  FOREIGN KEY (namespace, session_id, run_id)
    REFERENCES agent_runtime.runs(namespace, session_id, id) ON DELETE CASCADE
);

REVOKE ALL ON SCHEMA agent_runtime FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA agent_runtime FROM PUBLIC;
`;

const SESSION_OWNERSHIP_SQL = `
ALTER TABLE agent_runtime.sessions ADD COLUMN ownership_json jsonb;
`;

interface Migration {
  version: number;
  name: string;
  sql: string;
  checksum: string;
}

const MIGRATIONS: readonly Migration[] = Object.freeze([
  Object.freeze({
    version: 1,
    name: "initial_session_store",
    sql: INITIAL_SCHEMA_SQL,
    checksum: createHash("sha256").update(INITIAL_SCHEMA_SQL).digest("hex"),
  }),
  Object.freeze({
    version: 2,
    name: "protected_session_ownership",
    sql: SESSION_OWNERSHIP_SQL,
    checksum: createHash("sha256").update(SESSION_OWNERSHIP_SQL).digest("hex"),
  }),
]);

export class PostgresSchemaMigrationRequiredError extends Error {
  constructor(message = "PostgreSQL Session Store schema is missing or outdated; run migrations") {
    super(message);
    this.name = "PostgresSchemaMigrationRequiredError";
  }
}

export class PostgresSchemaVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PostgresSchemaVersionError";
  }
}

export class PostgresSchemaPermissionError extends Error {
  constructor(privileges: readonly string[]) {
    super(`PostgreSQL Session Store runtime role lacks required privileges: ${privileges.join("; ")}`);
    this.name = "PostgresSchemaPermissionError";
  }
}

/**
 * Explicit, profile-aware deployment operation. Runtime startup defaults to
 * check-only. Supabase migrations use TLS by default just like the Store factory.
 */
export async function migratePostgresSchema(
  config: PostgresSchemaMigrationConfig,
): Promise<void> {
  await migratePostgresSchemaWithPoolConfig(createPostgresMigrationPoolConfig(config));
}

/** @internal Public callers should use migratePostgresSchema. */
export function createPostgresMigrationPoolConfig(
  config: PostgresSchemaMigrationConfig,
): PoolConfig {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new DatabaseConfigurationError("PostgreSQL migration config must be an object");
  }
  if (config.profile !== "postgres" && config.profile !== "supabase") {
    throw new DatabaseConfigurationError("PostgreSQL migration profile must be postgres or supabase");
  }
  const connectionString = config.profile === "postgres"
    ? config.connectionString
    : config.databaseUrl;
  assertMigrationConnectionString(connectionString, config.profile);
  const ssl = resolvePostgresPoolSsl(
    connectionString,
    config.profile,
    config.ssl,
    config.profile === "postgres" ? "connectionString" : "databaseUrl",
  );
  return {
    connectionString,
    max: 1,
    connectionTimeoutMillis: positiveIntegerOrDefault(
      config.connectionTimeoutMillis,
      5_000,
      "connectionTimeoutMillis",
    ),
    idleTimeoutMillis: nonNegativeIntegerOrDefault(
      config.idleTimeoutMillis,
      30_000,
      "idleTimeoutMillis",
    ),
    application_name: "42-agent-session-store-migration",
    ...(ssl === undefined ? {} : { ssl }),
  };
}

async function migratePostgresSchemaWithPoolConfig(poolConfig: PoolConfig): Promise<void> {
  const pool = new Pool(poolConfig);
  const idleErrorListener = () => {
    // Query/connect failures are surfaced by their own Promises. This listener
    // prevents a separately failing idle client from becoming an uncaught
    // EventEmitter error while the short-lived migration Pool is closing.
  };
  pool.on("error", idleErrorListener);
  let client: PoolClient | undefined;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    try {
      // This lock coordinates DDL only. It does not add shared-session semantics.
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('42-agent:agent_runtime:migrations', 0))",
      );
      await client.query(`
        CREATE SCHEMA IF NOT EXISTS agent_runtime;
        REVOKE ALL ON SCHEMA agent_runtime FROM PUBLIC;
        CREATE TABLE IF NOT EXISTS agent_runtime.schema_migrations (
          version integer PRIMARY KEY,
          name text NOT NULL,
          checksum text NOT NULL,
          applied_at timestamptz NOT NULL DEFAULT now()
        );
        REVOKE ALL ON agent_runtime.schema_migrations FROM PUBLIC;
      `);
      const applied = await loadAppliedMigrations(client);
      assertKnownMigrations(applied, false);
      for (const migration of MIGRATIONS) {
        if (applied.has(migration.version)) continue;
        await client.query(migration.sql);
        await client.query(
          `INSERT INTO agent_runtime.schema_migrations(version, name, checksum)
           VALUES ($1, $2, $3)`,
          [migration.version, migration.name, migration.checksum],
        );
      }
      await assertSchemaWithClient(client);
      await client.query("COMMIT");
    } catch (error) {
      await rollbackPreservingError(client);
      throw error;
    }
  } finally {
    client?.release();
    try {
      await pool.end();
    } finally {
      pool.off("error", idleErrorListener);
    }
  }
}

function assertMigrationConnectionString(
  value: unknown,
  profile: "postgres" | "supabase",
): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new DatabaseConfigurationError(
      `${profile} migration requires a PostgreSQL connection URL`,
    );
  }
  try {
    const parsed = new URL(value);
    if ((parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:")
      || parsed.hostname.length === 0
      || parsed.pathname.length <= 1) {
      throw new Error("invalid PostgreSQL URL");
    }
  } catch {
    throw new DatabaseConfigurationError(
      `${profile} migration requires a PostgreSQL connection URL`,
    );
  }
}

function positiveIntegerOrDefault(value: unknown, fallback: number, field: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || Number(resolved) <= 0) {
    throw new DatabaseConfigurationError(`${field} must be a positive integer`);
  }
  return Number(resolved);
}

function nonNegativeIntegerOrDefault(value: unknown, fallback: number, field: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || Number(resolved) < 0) {
    throw new DatabaseConfigurationError(`${field} must be a non-negative integer`);
  }
  return Number(resolved);
}

/** @internal Store readiness helper; not part of the public storage API. */
export async function assertPostgresSchema(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await assertSchemaWithClient(client);
  } finally {
    client.release();
  }
}

async function assertSchemaWithClient(client: PoolClient): Promise<void> {
  const migrationTable = await client.query<{ relation: string | null }>(
    "SELECT to_regclass('agent_runtime.schema_migrations')::text AS relation",
  );
  if (!migrationTable.rows[0]?.relation) throw new PostgresSchemaMigrationRequiredError();
  const requiredTables = ["sessions", "messages", "runs", "tool_calls"];
  const relations = await client.query<{ name: string; relation: string | null }>(
    `SELECT name, to_regclass('agent_runtime.' || name)::text AS relation
     FROM unnest($1::text[]) AS name`,
    [requiredTables],
  );
  const missing = relations.rows.filter((row) => row.relation === null).map((row) => row.name);
  if (missing.length > 0) {
    throw new PostgresSchemaMigrationRequiredError(
      `PostgreSQL Session Store schema is missing tables: ${missing.join(", ")}`,
    );
  }
  await assertRuntimePrivileges(client);
  const applied = await loadAppliedMigrations(client);
  assertKnownMigrations(applied, true);
}

async function assertRuntimePrivileges(client: PoolClient): Promise<void> {
  const required = [
    ["schema_migrations", ["SELECT"]],
    ["sessions", ["SELECT", "INSERT", "UPDATE", "DELETE"]],
    ["messages", ["SELECT", "INSERT", "UPDATE", "DELETE"]],
    ["runs", ["SELECT", "INSERT", "UPDATE", "DELETE"]],
    ["tool_calls", ["SELECT", "INSERT", "UPDATE", "DELETE"]],
  ] as const;
  const checks = required.flatMap(([name, privileges]) => (
    privileges.map((privilege) => ({ name, privilege }))
  ));
  const result = await client.query<{
    name: string;
    privilege: string;
    schema_usage: boolean;
    allowed: boolean;
  }>(
    `WITH required(name, privilege) AS (
       SELECT * FROM unnest($1::text[], $2::text[])
     )
     SELECT required.name, required.privilege,
            has_schema_privilege(current_user, namespace.oid, 'USAGE') AS schema_usage,
            has_table_privilege(current_user, relation.oid, required.privilege) AS allowed
     FROM required
     JOIN pg_namespace AS namespace ON namespace.nspname = 'agent_runtime'
     JOIN pg_class AS relation
       ON relation.relnamespace = namespace.oid AND relation.relname = required.name`,
    [checks.map(({ name }) => name), checks.map(({ privilege }) => privilege)],
  );
  const missing: string[] = [];
  if (!result.rows[0]?.schema_usage) missing.push("USAGE on schema agent_runtime");
  const allowed = new Map(
    result.rows.map((row) => [`${row.name}:${row.privilege}`, row.allowed]),
  );
  for (const [name, privileges] of required) {
    const absent = privileges.filter((privilege) => !allowed.get(`${name}:${privilege}`));
    if (absent.length > 0) missing.push(`${absent.join(", ")} on agent_runtime.${name}`);
  }
  if (missing.length > 0) throw new PostgresSchemaPermissionError(missing);
}

async function loadAppliedMigrations(client: PoolClient): Promise<Map<number, AppliedMigration>> {
  const result = await client.query<AppliedMigration>(
    "SELECT version, name, checksum FROM agent_runtime.schema_migrations ORDER BY version",
  );
  return new Map(result.rows.map((row) => [Number(row.version), {
    version: Number(row.version),
    name: row.name,
    checksum: row.checksum,
  }]));
}

interface AppliedMigration extends QueryResultRow {
  version: number;
  name: string;
  checksum: string;
}

function assertKnownMigrations(
  applied: ReadonlyMap<number, AppliedMigration>,
  requireAll: boolean,
): void {
  for (const [version, row] of applied) {
    const expected = MIGRATIONS.find((migration) => migration.version === version);
    if (!expected) {
      throw new PostgresSchemaVersionError(
        `PostgreSQL Session Store schema version ${version} is newer than this runtime`,
      );
    }
    if (row.name !== expected.name || row.checksum !== expected.checksum) {
      throw new PostgresSchemaVersionError(
        `PostgreSQL Session Store migration ${version} does not match its expected checksum`,
      );
    }
  }
  if (requireAll) {
    const missing = MIGRATIONS.filter((migration) => !applied.has(migration.version));
    if (missing.length > 0) throw new PostgresSchemaMigrationRequiredError();
  }
}

async function rollbackPreservingError(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the migration failure; a rollback error contains less useful context.
  }
}
