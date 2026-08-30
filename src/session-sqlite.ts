import { DatabaseSync } from "node:sqlite";
import { dirname, resolve } from "node:path";
import { mkdirSync } from "node:fs";
import {
  assertValidSessionId,
  MessageHistoryRewriteRequiredError,
  resolveSessionOwnershipSave,
  restoreSessionOwnership,
  SessionAlreadyExistsError,
  SessionVersionConflictError,
  snapshotSessionOwnership,
  type Message,
  type RunState,
  type SaveSessionOptions,
  type Session,
  type SessionCreateOptions,
  type SessionStore,
  type ToolCallState,
} from "./session.js";

/** Durable, transactional store for a single SQLite database. */
export class SqliteSessionStore implements SessionStore {
  readonly supportsSessionOwnership = true as const;

  private readonly database: DatabaseSync;
  private readonly messageSnapshots = new WeakMap<Session, MessageSnapshot>();

  constructor(filename: string) {
    const path = resolve(filename);
    mkdirSync(dirname(path), { recursive: true });
    this.database = new DatabaseSync(path);
    this.database.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  async get(sessionId: string): Promise<Session | undefined> {
    assertValidSessionId(sessionId);
    const row = this.database.prepare(
      "SELECT id, version, metadata_json, ownership_json, current_run_id FROM sessions WHERE id = ?",
    ).get(sessionId) as {
      id: string;
      version: number;
      metadata_json: string;
      ownership_json: string | null;
      current_run_id: string | null;
    } | undefined;
    if (!row) return undefined;
    const messages = this.loadMessages(sessionId);
    const run = this.database.prepare(
      `SELECT id, status, phase, round, error, started_at, updated_at
       FROM runs WHERE session_id = ? AND id = ?`,
    ).get(sessionId, row.current_run_id) as Record<string, unknown> | undefined;
    const ownership = parseStoredOwnership(row.ownership_json);
    const session: Session = {
      id: row.id,
      version: Number(row.version),
      metadata: JSON.parse(row.metadata_json),
      messages,
      ...(ownership ? { ownership } : {}),
      runState: run ? this.loadRun(run) : undefined,
    };
    this.messageSnapshots.set(session, snapshotMessages(messages));
    return session;
  }

  async create(
    sessionId: string,
    metadata: Record<string, unknown> = {},
    options: SessionCreateOptions = {},
  ): Promise<Session> {
    assertValidSessionId(sessionId);
    const ownership = snapshotSessionOwnership(options.ownership);
    const now = new Date().toISOString();
    try {
      this.database.prepare(
        `INSERT INTO sessions
         (id, version, metadata_json, ownership_json, created_at, updated_at)
         VALUES (?, 0, ?, ?, ?, ?)`,
      ).run(
        sessionId,
        JSON.stringify(metadata),
        ownership ? JSON.stringify(ownership) : null,
        now,
        now,
      );
    } catch (error) {
      if (/UNIQUE constraint failed/.test(String(error))) throw new SessionAlreadyExistsError(sessionId);
      throw error;
    }
    const session: Session = {
      id: sessionId,
      version: 0,
      messages: [],
      metadata,
      ...(ownership ? { ownership } : {}),
    };
    this.messageSnapshots.set(session, snapshotMessages([]));
    return session;
  }

  async getOrCreate(sessionId: string): Promise<Session> {
    assertValidSessionId(sessionId);
    const existing = await this.get(sessionId);
    if (existing) return existing;
    try {
      return await this.create(sessionId);
    } catch (error) {
      if (!(error instanceof SessionAlreadyExistsError)) throw error;
      const created = await this.get(sessionId);
      if (created) return created;
      throw error;
    }
  }

  async save(session: Session, options: SaveSessionOptions = {}): Promise<void> {
    assertValidSessionId(session.id);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.database.prepare(
        "SELECT version, ownership_json FROM sessions WHERE id = ?",
      ).get(session.id) as { version: number; ownership_json: string | null } | undefined;
      const expected = session.version ?? 0;
      if (!existing) {
        throw new SessionVersionConflictError(session.id, expected, -1);
      } else if (Number(existing.version) !== expected) {
        throw new SessionVersionConflictError(session.id, expected, Number(existing.version));
      }
      const ownership = resolveSessionOwnershipSave(
        session.id,
        parseStoredOwnership(existing.ownership_json),
        session.ownership,
        options.claimOwnership === true,
      );
      const nextVersion = expected + 1;
      const updated = this.database.prepare(
        `UPDATE sessions
         SET version = ?, metadata_json = ?, ownership_json = ?, current_run_id = ?, updated_at = ?
         WHERE id = ? AND version = ?`,
      ).run(
        nextVersion,
        JSON.stringify(session.metadata),
        ownership ? JSON.stringify(ownership) : null,
        session.runState?.id ?? null,
        new Date().toISOString(),
        session.id,
        expected,
      );
      if (Number(updated.changes) !== 1) {
        const actual = this.database.prepare("SELECT version FROM sessions WHERE id = ?")
          .get(session.id) as { version: number } | undefined;
        throw new SessionVersionConflictError(session.id, expected, Number(actual?.version ?? -1));
      }

      if (options.rewriteMessages) {
        this.database.prepare("DELETE FROM messages WHERE session_id = ?").run(session.id);
      }
      const persistedCount = options.rewriteMessages ? 0 : this.persistedMessageCount(session.id);
      if (!options.rewriteMessages) {
        const known = this.messageSnapshots.get(session);
        const snapshot = known?.count === persistedCount
          ? known
          : snapshotMessages(this.loadMessages(session.id));
        assertAppendOnlySnapshot(session.id, snapshot, session.messages);
      }
      const insertMessage = this.database.prepare(
        `INSERT INTO messages
         (session_id, sequence, role, content, name, tool_call_id, metadata_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (let sequence = persistedCount; sequence < session.messages.length; sequence += 1) {
        const message = session.messages[sequence]!;
        insertMessage.run(
          session.id, sequence, message.role, message.content, message.name ?? null,
          message.toolCallId ?? null, message.metadata ? JSON.stringify(message.metadata) : null,
          message.createdAt ?? null,
        );
      }
      if (session.runState) this.saveRun(session.id, session.runState);
      this.database.exec("COMMIT");
      session.version = nextVersion;
      restoreSessionOwnership(session, ownership);
      const previous = this.messageSnapshots.get(session);
      this.messageSnapshots.set(
        session,
        !options.rewriteMessages && previous?.count === persistedCount
          ? appendMessageSnapshot(previous, session.messages)
          : snapshotMessages(session.messages),
      );
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.database.close();
  }

  async delete(sessionId: string): Promise<boolean> {
    assertValidSessionId(sessionId);
    const result = this.database.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
    return Number(result.changes) > 0;
  }

  private saveRun(sessionId: string, run: RunState): void {
    this.database.prepare(
      `INSERT INTO runs (id, session_id, status, phase, round, error, started_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET status=excluded.status, phase=excluded.phase,
       round=excluded.round, error=excluded.error, updated_at=excluded.updated_at`,
    ).run(run.id, sessionId, run.status, run.phase, run.round, run.error ?? null, run.startedAt, run.updatedAt);
    if (run.toolCalls.length === 0) {
      this.database.prepare("DELETE FROM tool_calls WHERE run_id = ?").run(run.id);
    } else {
      const placeholders = run.toolCalls.map(() => "?").join(", ");
      this.database.prepare(
        `DELETE FROM tool_calls WHERE run_id = ? AND id NOT IN (${placeholders})`,
      ).run(run.id, ...run.toolCalls.map((call) => call.id));
    }
    const insert = this.database.prepare(
      `INSERT INTO tool_calls (id, run_id, call_index, name, arguments_json, status, result_json, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_id, id) DO UPDATE SET
       call_index=excluded.call_index, name=excluded.name,
       arguments_json=excluded.arguments_json, status=excluded.status,
       result_json=excluded.result_json, error=excluded.error`,
    );
    run.toolCalls.forEach((call, index) => insert.run(
      call.id, run.id, index, call.name, JSON.stringify(call.arguments), call.status,
      call.result === undefined ? null : JSON.stringify(call.result), call.error ?? null,
    ));
  }

  private persistedMessageCount(sessionId: string): number {
    const row = this.database.prepare(
      "SELECT COUNT(*) AS count FROM messages WHERE session_id = ?",
    ).get(sessionId) as { count: number };
    return Number(row.count);
  }

  private loadMessages(sessionId: string): Message[] {
    const messages = this.database.prepare(
      `SELECT role, content, name, tool_call_id, metadata_json, created_at
       FROM messages WHERE session_id = ? ORDER BY sequence`,
    ).all(sessionId) as Array<Record<string, unknown>>;
    return messages.map((message) => ({
      role: message.role as Message["role"],
      content: String(message.content),
      name: nullableString(message.name),
      toolCallId: nullableString(message.tool_call_id),
      metadata: message.metadata_json ? JSON.parse(String(message.metadata_json)) : undefined,
      createdAt: nullableString(message.created_at),
    }));
  }

  private loadRun(row: Record<string, unknown>): RunState {
    const calls = this.database.prepare(
      `SELECT id, name, arguments_json, status, result_json, error
       FROM tool_calls WHERE run_id = ? ORDER BY call_index`,
    ).all(String(row.id)) as Array<Record<string, unknown>>;
    return {
      id: String(row.id), status: row.status as RunState["status"],
      phase: row.phase as RunState["phase"], round: Number(row.round),
      error: nullableString(row.error), startedAt: String(row.started_at),
      updatedAt: String(row.updated_at),
      toolCalls: calls.map((call): ToolCallState => ({
        id: String(call.id), name: String(call.name),
        arguments: JSON.parse(String(call.arguments_json)),
        status: call.status as ToolCallState["status"],
        result: call.result_json == null ? undefined : JSON.parse(String(call.result_json)),
        error: nullableString(call.error),
      })),
    };
  }

  private migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, version INTEGER NOT NULL, metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, current_run_id TEXT
      );
      CREATE TABLE IF NOT EXISTS messages (
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL,
        name TEXT, tool_call_id TEXT, metadata_json TEXT, created_at TEXT,
        PRIMARY KEY (session_id, sequence)
      );
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        status TEXT NOT NULL, phase TEXT NOT NULL, round INTEGER NOT NULL,
        error TEXT, started_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS runs_session_started ON runs(session_id, started_at DESC);
      CREATE TABLE IF NOT EXISTS tool_calls (
        id TEXT NOT NULL, run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        call_index INTEGER NOT NULL, name TEXT NOT NULL, arguments_json TEXT NOT NULL,
        status TEXT NOT NULL, result_json TEXT, error TEXT,
        PRIMARY KEY (run_id, id), UNIQUE (run_id, call_index)
      );
      INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (1, CURRENT_TIMESTAMP);
    `);
    const sessionColumns = this.database.prepare("PRAGMA table_info(sessions)").all() as Array<{
      name: string;
    }>;
    if (!sessionColumns.some((column) => column.name === "current_run_id")) {
      this.database.exec("ALTER TABLE sessions ADD COLUMN current_run_id TEXT");
    }
    this.database.exec(`
      UPDATE sessions
      SET current_run_id = (
        SELECT id FROM runs
        WHERE runs.session_id = sessions.id
        ORDER BY started_at DESC, rowid DESC
        LIMIT 1
      )
      WHERE current_run_id IS NULL;
      INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (2, CURRENT_TIMESTAMP);
    `);
    if (!sessionColumns.some((column) => column.name === "ownership_json")) {
      this.database.exec("ALTER TABLE sessions ADD COLUMN ownership_json TEXT");
    }
    this.database.exec(
      "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (3, CURRENT_TIMESTAMP)",
    );
  }
}

function nullableString(value: unknown): string | undefined {
  return value == null ? undefined : String(value);
}

function parseStoredOwnership(value: unknown): Session["ownership"] {
  return value == null ? undefined : snapshotSessionOwnership(JSON.parse(String(value)));
}

interface MessageSnapshot {
  count: number;
  json: string;
}

function snapshotMessages(messages: readonly Message[]): MessageSnapshot {
  return { count: messages.length, json: JSON.stringify(messages) };
}

function assertAppendOnlySnapshot(
  sessionId: string,
  snapshot: MessageSnapshot,
  messages: readonly Message[],
): void {
  if (snapshot.count > messages.length
    || JSON.stringify(messages.slice(0, snapshot.count)) !== snapshot.json) {
    throw new MessageHistoryRewriteRequiredError(sessionId);
  }
}

function appendMessageSnapshot(
  snapshot: MessageSnapshot,
  messages: readonly Message[],
): MessageSnapshot {
  if (messages.length === snapshot.count) return snapshot;
  const appended = JSON.stringify(messages.slice(snapshot.count));
  return {
    count: messages.length,
    json: snapshot.count === 0
      ? appended
      : `${snapshot.json.slice(0, -1)},${appended.slice(1)}`,
  };
}
