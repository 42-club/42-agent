import { randomUUID } from "node:crypto";
import { Pool, type PoolClient, type PoolConfig, type QueryResultRow } from "pg";
import {
  assertValidSessionId,
  MessageHistoryRewriteRequiredError,
  resolveSessionOwnershipSave,
  restoreSessionOwnership,
  SessionAlreadyExistsError,
  SessionSaveOutcomeUnknownError,
  SessionVersionConflictError,
  snapshotSessionOwnership,
  type Message,
  type RunState,
  type SaveSessionOptions,
  type Session,
  type SessionCreateOptions,
  type ToolCallState,
} from "../session.js";
import { validateDatabaseNamespace } from "./config.js";
import { StoreLifecycle } from "./lifecycle.js";
import { assertPostgresSchema } from "./postgres-migrations.js";
import { resolvePostgresPoolSsl } from "./postgres-tls.js";
import type { ManagedSessionStore } from "./types.js";

export interface PostgresSessionStoreOptions {
  connectionString: string;
  namespace: string;
  profile?: "postgres" | "supabase";
  maxConnections?: number;
  connectionTimeoutMillis?: number;
  idleTimeoutMillis?: number;
  ssl?: boolean;
  /** Best-effort notification for an idle client error already handled by pg Pool. */
  onPoolError?: (error: Error) => void;
  /** @internal The Store assumes ownership and closes an injected Pool. */
  pool?: Pool;
}

/**
 * PostgreSQL implementation shared by native PostgreSQL and Supabase profiles.
 * Every checkpoint uses one checked-out client for its complete transaction.
 */
export class PostgresSessionStore implements ManagedSessionStore {
  readonly supportsSessionOwnership = true as const;
  readonly profile: "postgres" | "supabase";
  readonly engine = "postgres" as const;
  readonly namespace: string;

  private readonly pool: Pool;
  private readonly lifecycle = new StoreLifecycle();
  private readonly idlePoolErrorListener: (error: Error) => void;

  constructor(options: PostgresSessionStoreOptions) {
    this.profile = options.profile ?? "postgres";
    this.namespace = validateDatabaseNamespace(options.namespace);
    this.pool = options.pool ?? new Pool(createPostgresPoolConfig(options));
    this.idlePoolErrorListener = (error) => {
      try {
        options.onPoolError?.(error);
      } catch {
        // A diagnostic observer cannot turn an already-handled idle client
        // failure into an uncaught EventEmitter exception.
      }
    };
    this.pool.on("error", this.idlePoolErrorListener);
  }

  readinessCheck(): Promise<void> {
    return this.lifecycle.run(async () => {
      await this.pool.query("SELECT 1");
      await assertPostgresSchema(this.pool);
    });
  }

  get(sessionId: string): Promise<Session | undefined> {
    return this.lifecycle.run(async () => {
      assertValidSessionId(sessionId);
      return this.withReadTransaction(async (client) => this.loadSession(client, sessionId));
    });
  }

  create(
    sessionId: string,
    metadata: Record<string, unknown> = {},
    options: SessionCreateOptions = {},
  ): Promise<Session> {
    return this.lifecycle.run(async () => {
      assertValidSessionId(sessionId);
      assertPostgresCompatibleValue(metadata);
      const ownership = snapshotSessionOwnership(options.ownership);
      try {
        await this.pool.query(
          `INSERT INTO agent_runtime.sessions
           (namespace, id, version, metadata_json, ownership_json)
           VALUES ($1, $2, 0, $3::jsonb, $4::jsonb)`,
          [
            this.namespace,
            sessionId,
            serializeJson(metadata),
            ownership ? serializeJson(ownership) : null,
          ],
        );
      } catch (error) {
        if (isPostgresError(error, "23505")) throw new SessionAlreadyExistsError(sessionId);
        throw error;
      }
      return {
        id: sessionId,
        version: 0,
        messages: [],
        metadata,
        ...(ownership ? { ownership } : {}),
      };
    });
  }

  getOrCreate(sessionId: string): Promise<Session> {
    return this.lifecycle.run(async () => {
      assertValidSessionId(sessionId);
      const existing = await this.withReadTransaction(
        async (client) => this.loadSession(client, sessionId),
      );
      if (existing) return existing;
      try {
        await this.pool.query(
          `INSERT INTO agent_runtime.sessions(namespace, id, version, metadata_json)
           VALUES ($1, $2, 0, '{}'::jsonb)`,
          [this.namespace, sessionId],
        );
        return { id: sessionId, version: 0, messages: [], metadata: {} };
      } catch (error) {
        if (!isPostgresError(error, "23505")) throw error;
        const created = await this.withReadTransaction(
          async (client) => this.loadSession(client, sessionId),
        );
        if (created) return created;
        throw new SessionAlreadyExistsError(sessionId);
      }
    });
  }

  save(session: Session, options: SaveSessionOptions = {}): Promise<void> {
    return this.lifecycle.run(async () => {
      assertValidSessionId(session.id);
      await this.saveCheckpoint(session, options);
    });
  }

  delete(sessionId: string): Promise<boolean> {
    return this.lifecycle.run(async () => {
      assertValidSessionId(sessionId);
      const result = await this.pool.query(
        "DELETE FROM agent_runtime.sessions WHERE namespace = $1 AND id = $2",
        [this.namespace, sessionId],
      );
      return (result.rowCount ?? 0) > 0;
    });
  }

  close(): Promise<void> {
    return this.lifecycle.close(async () => {
      try {
        await this.pool.end();
      } finally {
        this.pool.off("error", this.idlePoolErrorListener);
      }
    });
  }

  private async saveCheckpoint(session: Session, options: SaveSessionOptions): Promise<void> {
    assertPostgresCompatibleValue(session);
    const client = await this.pool.connect();
    const expected = session.version ?? 0;
    const nextVersion = expected + 1;
    const checkpointId = randomUUID();
    let transactionStarted = false;
    let commitAttempted = false;
    let destroyClient = false;
    let clientReleased = false;
    try {
      await client.query("BEGIN");
      transactionStarted = true;
      const current = await client.query<{
        version: string | number;
        ownership_json: unknown | null;
      }>(
        `SELECT version, ownership_json FROM agent_runtime.sessions
         WHERE namespace = $1 AND id = $2 FOR UPDATE`,
        [this.namespace, session.id],
      );
      const actual = current.rows[0] ? parseVersion(current.rows[0].version) : -1;
      if (actual !== expected) {
        throw new SessionVersionConflictError(session.id, expected, actual);
      }
      const ownership = resolveSessionOwnershipSave(
        session.id,
        parseStoredOwnership(current.rows[0]?.ownership_json),
        session.ownership,
        options.claimOwnership === true,
      );

      const persistedMessages = options.rewriteMessages
        ? []
        : await this.loadMessages(client, session.id);
      if (!options.rewriteMessages) {
        assertAppendOnlyPostgresHistory(session.id, persistedMessages, session.messages);
      } else {
        await client.query(
          "DELETE FROM agent_runtime.messages WHERE namespace = $1 AND session_id = $2",
          [this.namespace, session.id],
        );
      }

      const firstNewSequence = options.rewriteMessages ? 0 : persistedMessages.length;
      await this.insertMessages(client, session.id, session.messages, firstNewSequence);
      if (session.runState) await this.upsertRun(client, session.id, session.runState);

      const updated = await client.query(
        `UPDATE agent_runtime.sessions
         SET version = $3, metadata_json = $4::jsonb, ownership_json = $5::jsonb,
             current_run_id = $6, last_checkpoint_id = $7, updated_at = now()
         WHERE namespace = $1 AND id = $2 AND version = $8`,
        [
          this.namespace,
          session.id,
          nextVersion,
          serializeJson(session.metadata),
          ownership ? serializeJson(ownership) : null,
          session.runState?.id ?? null,
          checkpointId,
          expected,
        ],
      );
      if (updated.rowCount !== 1) {
        const actualRow = await client.query<{ version: string | number }>(
          "SELECT version FROM agent_runtime.sessions WHERE namespace = $1 AND id = $2",
          [this.namespace, session.id],
        );
        throw new SessionVersionConflictError(
          session.id,
          expected,
          actualRow.rows[0] ? parseVersion(actualRow.rows[0].version) : -1,
        );
      }

      commitAttempted = true;
      try {
        await client.query("COMMIT");
      } catch (commitError) {
        destroyClient = true;
        // Release the uncertain connection before verification. This is
        // required for pools configured with max=1 and prevents reuse of a
        // connection whose transaction outcome is not known to the client.
        client.release(true);
        clientReleased = true;
        const committed = await this.verifyCheckpoint(session.id, nextVersion, checkpointId);
        if (!committed) {
          throw new PostgresTransactionOutcomeUnknownError(
            session.id,
            checkpointId,
            commitError,
          );
        }
      }
      session.version = nextVersion;
      restoreSessionOwnership(session, ownership);
    } catch (error) {
      if (transactionStarted && !commitAttempted) {
        const rolledBack = await rollbackPreservingError(client);
        if (!rolledBack) destroyClient = true;
      }
      throw error;
    } finally {
      if (!clientReleased) client.release(destroyClient);
    }
  }

  private async verifyCheckpoint(
    sessionId: string,
    version: number,
    checkpointId: string,
  ): Promise<boolean> {
    try {
      const result = await this.pool.query<{
        version: string | number;
        last_checkpoint_id: string | null;
      }>(
        `SELECT version, last_checkpoint_id FROM agent_runtime.sessions
         WHERE namespace = $1 AND id = $2`,
        [this.namespace, sessionId],
      );
      const row = result.rows[0];
      return Boolean(row
        && parseVersion(row.version) === version
        && row.last_checkpoint_id === checkpointId);
    } catch {
      return false;
    }
  }

  private async withReadTransaction<Result>(
    operation: (client: PoolClient) => Promise<Result>,
  ): Promise<Result> {
    const client = await this.pool.connect();
    let destroyClient = false;
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      try {
        const result = await operation(client);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        if (!await rollbackPreservingError(client)) destroyClient = true;
        throw error;
      }
    } finally {
      client.release(destroyClient);
    }
  }

  private async loadSession(client: PoolClient, sessionId: string): Promise<Session | undefined> {
    const result = await client.query<SessionRow>(
      `SELECT id, version, metadata_json, ownership_json, current_run_id
       FROM agent_runtime.sessions WHERE namespace = $1 AND id = $2`,
      [this.namespace, sessionId],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    const messages = await this.loadMessages(client, sessionId);
    const runState = row.current_run_id
      ? await this.loadRun(client, sessionId, row.current_run_id)
      : undefined;
    const ownership = parseStoredOwnership(row.ownership_json);
    return {
      id: row.id,
      version: parseVersion(row.version),
      metadata: parseJson<Record<string, unknown>>(row.metadata_json),
      messages,
      ...(ownership ? { ownership } : {}),
      runState,
    };
  }

  private async loadMessages(client: PoolClient, sessionId: string): Promise<Message[]> {
    const result = await client.query<MessageRow>(
      `SELECT role, content, name, tool_call_id, metadata_json, created_at
       FROM agent_runtime.messages
       WHERE namespace = $1 AND session_id = $2 ORDER BY sequence`,
      [this.namespace, sessionId],
    );
    return result.rows.map((row): Message => ({
      role: row.role,
      content: row.content,
      name: row.name ?? undefined,
      toolCallId: row.tool_call_id ?? undefined,
      metadata: row.metadata_json === null
        ? undefined
        : parseJson<Record<string, unknown>>(row.metadata_json),
      createdAt: row.created_at ?? undefined,
    }));
  }

  private async loadRun(
    client: PoolClient,
    sessionId: string,
    runId: string,
  ): Promise<RunState | undefined> {
    const result = await client.query<RunRow>(
      `SELECT id, status, phase, round, error, started_at, updated_at
       FROM agent_runtime.runs
       WHERE namespace = $1 AND session_id = $2 AND id = $3`,
      [this.namespace, sessionId, runId],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    const calls = await client.query<ToolCallRow>(
      `SELECT id, name, arguments_json, status, result_json,
              result_json IS NULL AS result_missing, error
       FROM agent_runtime.tool_calls
       WHERE namespace = $1 AND session_id = $2 AND run_id = $3
       ORDER BY call_index`,
      [this.namespace, sessionId, runId],
    );
    return {
      id: row.id,
      status: row.status,
      phase: row.phase,
      round: Number(row.round),
      error: row.error ?? undefined,
      startedAt: row.started_at,
      updatedAt: row.updated_at,
      toolCalls: calls.rows.map((call): ToolCallState => ({
        id: call.id,
        name: call.name,
        arguments: parseJson<Record<string, unknown>>(call.arguments_json),
        status: call.status,
        result: call.result_missing ? undefined : parseJson(call.result_json),
        error: call.error ?? undefined,
      })),
    };
  }

  private async insertMessages(
    client: PoolClient,
    sessionId: string,
    messages: readonly Message[],
    firstSequence: number,
  ): Promise<void> {
    const pending = messages.slice(firstSequence);
    for (let offset = 0; offset < pending.length; offset += 500) {
      const chunk = pending.slice(offset, offset + 500);
      const values: unknown[] = [];
      const rows = chunk.map((message, index) => {
        const base = values.length;
        values.push(
          this.namespace,
          sessionId,
          firstSequence + offset + index,
          message.role,
          message.content,
          message.name ?? null,
          message.toolCallId ?? null,
          message.metadata === undefined ? null : serializeJson(message.metadata),
          message.createdAt ?? null,
        );
        return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5},
          $${base + 6}, $${base + 7}, $${base + 8}::jsonb, $${base + 9})`;
      });
      await client.query(
        `INSERT INTO agent_runtime.messages
         (namespace, session_id, sequence, role, content, name, tool_call_id, metadata_json, created_at)
         VALUES ${rows.join(", ")}`,
        values,
      );
    }
  }

  private async upsertRun(client: PoolClient, sessionId: string, run: RunState): Promise<void> {
    await client.query(
      `INSERT INTO agent_runtime.runs
       (namespace, session_id, id, status, phase, round, error, started_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (namespace, session_id, id) DO UPDATE SET
         status = excluded.status, phase = excluded.phase, round = excluded.round,
         error = excluded.error, started_at = excluded.started_at, updated_at = excluded.updated_at`,
      [
        this.namespace, sessionId, run.id, run.status, run.phase, run.round,
        run.error ?? null, run.startedAt, run.updatedAt,
      ],
    );
    await client.query(
      `DELETE FROM agent_runtime.tool_calls
       WHERE namespace = $1 AND session_id = $2 AND run_id = $3
         AND NOT (id = ANY($4::text[]))`,
      [this.namespace, sessionId, run.id, run.toolCalls.map((call) => call.id)],
    );
    for (let offset = 0; offset < run.toolCalls.length; offset += 250) {
      const chunk = run.toolCalls.slice(offset, offset + 250);
      const values: unknown[] = [];
      const rows = chunk.map((call, index) => {
        const base = values.length;
        values.push(
          this.namespace,
          sessionId,
          run.id,
          call.id,
          offset + index,
          call.name,
          serializeJson(call.arguments),
          call.status,
          call.result === undefined ? null : serializeJson(call.result),
          call.error ?? null,
        );
        return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5},
          $${base + 6}, $${base + 7}::jsonb, $${base + 8}, $${base + 9}::jsonb, $${base + 10})`;
      });
      await client.query(
        `INSERT INTO agent_runtime.tool_calls
         (namespace, session_id, run_id, id, call_index, name, arguments_json, status, result_json, error)
         VALUES ${rows.join(", ")}
         ON CONFLICT (namespace, session_id, run_id, id) DO UPDATE SET
           call_index = excluded.call_index, name = excluded.name,
           arguments_json = excluded.arguments_json, status = excluded.status,
           result_json = excluded.result_json, error = excluded.error`,
        values,
      );
    }
  }
}

export class PostgresTransactionOutcomeUnknownError extends SessionSaveOutcomeUnknownError {
  readonly sessionId: string;
  readonly checkpointId: string;

  constructor(sessionId: string, checkpointId: string, cause: unknown) {
    super(
      `PostgreSQL checkpoint outcome is unknown for Session ${sessionId}; reload before retrying`,
      { cause },
    );
    this.name = "PostgresTransactionOutcomeUnknownError";
    this.sessionId = sessionId;
    this.checkpointId = checkpointId;
  }
}

/** @internal Shared factory/test helper; public callers should use openSessionStore. */
export function createPostgresPoolConfig(options: PostgresSessionStoreOptions): PoolConfig {
  const ssl = resolvePostgresPoolSsl(
    options.connectionString,
    options.profile ?? "postgres",
    options.ssl,
  );
  return {
    connectionString: options.connectionString,
    max: options.maxConnections ?? 10,
    connectionTimeoutMillis: options.connectionTimeoutMillis ?? 5_000,
    idleTimeoutMillis: options.idleTimeoutMillis ?? 30_000,
    application_name: "42-agent-session-store",
    ...(ssl === undefined ? {} : { ssl }),
  };
}

interface SessionRow extends QueryResultRow {
  id: string;
  version: string | number;
  metadata_json: unknown;
  ownership_json: unknown | null;
  current_run_id: string | null;
}

interface MessageRow extends QueryResultRow {
  role: Message["role"];
  content: string;
  name: string | null;
  tool_call_id: string | null;
  metadata_json: unknown | null;
  created_at: string | null;
}

interface RunRow extends QueryResultRow {
  id: string;
  status: RunState["status"];
  phase: RunState["phase"];
  round: number;
  error: string | null;
  started_at: string;
  updated_at: string;
}

interface ToolCallRow extends QueryResultRow {
  id: string;
  name: string;
  arguments_json: unknown;
  status: ToolCallState["status"];
  result_json: unknown | null;
  result_missing: boolean;
  error: string | null;
}

function assertAppendOnlyPostgresHistory(
  sessionId: string,
  persisted: readonly Message[],
  current: readonly Message[],
): void {
  if (persisted.length > current.length) throw new MessageHistoryRewriteRequiredError(sessionId);
  for (let index = 0; index < persisted.length; index += 1) {
    if (canonicalJson(persisted[index]) !== canonicalJson(current[index])) {
      throw new MessageHistoryRewriteRequiredError(sessionId);
    }
  }
}

function canonicalJson(value: unknown): string {
  const serialized = serializeJson(value);
  return JSON.stringify(sortJson(JSON.parse(serialized)));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => compareJsonKeys(left, right))
        .map(([key, nested]) => [key, sortJson(nested)]),
    );
  }
  return value;
}

function serializeJson(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError("Session value is not JSON serializable");
  return serialized;
}

function parseJson<Value = unknown>(value: unknown): Value {
  if (typeof value === "string") return JSON.parse(value) as Value;
  return structuredClone(value) as Value;
}

function parseStoredOwnership(value: unknown): Session["ownership"] {
  return value == null ? undefined : snapshotSessionOwnership(parseJson(value));
}

function parseVersion(value: string | number): number {
  const version = Number(value);
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new PostgresSessionDataError("Session version is not a safe non-negative integer");
  }
  return version;
}

function isPostgresError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === code;
}

function compareJsonKeys(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

async function rollbackPreservingError(client: PoolClient): Promise<boolean> {
  try {
    await client.query("ROLLBACK");
    return true;
  } catch {
    // Preserve the checkpoint error. The connection is released immediately afterwards.
    return false;
  }
}

function assertPostgresCompatibleValue(value: unknown, seen = new WeakSet<object>()): void {
  if (typeof value === "string") {
    if (value.includes("\0") || Buffer.from(value, "utf8").toString("utf8") !== value) {
      throw new PostgresSessionDataError(
        "PostgreSQL Session values must be NUL-free, well-formed Unicode strings",
      );
    }
    return;
  }
  if (typeof value !== "object" || value === null || seen.has(value)) return;
  seen.add(value);
  for (const [key, nested] of Object.entries(value)) {
    assertPostgresCompatibleValue(key, seen);
    assertPostgresCompatibleValue(nested, seen);
  }
}

export class PostgresSessionDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PostgresSessionDataError";
  }
}
