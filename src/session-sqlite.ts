import { DatabaseSync } from "node:sqlite";
import { dirname, resolve } from "node:path";
import { mkdirSync } from "node:fs";
import type { Message, RunState, SaveSessionOptions, Session, SessionStore, ToolCallState } from "./session.js";

/** Durable, transactional store for a single SQLite database. */
export class SqliteSessionStore implements SessionStore {
  private readonly database: DatabaseSync;

  constructor(filename: string) {
    const path = resolve(filename);
    mkdirSync(dirname(path), { recursive: true });
    this.database = new DatabaseSync(path);
    this.database.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  async getOrCreate(sessionId: string): Promise<Session> {
    const row = this.database.prepare(
      "SELECT id, version, metadata_json FROM sessions WHERE id = ?",
    ).get(sessionId) as { id: string; version: number; metadata_json: string } | undefined;
    if (!row) {
      const now = new Date().toISOString();
      this.database.prepare(
        "INSERT INTO sessions (id, version, metadata_json, created_at, updated_at) VALUES (?, 0, '{}', ?, ?)",
      ).run(sessionId, now, now);
      return { id: sessionId, version: 0, messages: [], metadata: {} };
    }
    const messages = this.database.prepare(
      `SELECT role, content, name, tool_call_id, metadata_json, created_at
       FROM messages WHERE session_id = ? ORDER BY sequence`,
    ).all(sessionId) as Array<Record<string, unknown>>;
    const run = this.database.prepare(
      `SELECT id, status, phase, round, error, started_at, updated_at
       FROM runs WHERE session_id = ? ORDER BY started_at DESC LIMIT 1`,
    ).get(sessionId) as Record<string, unknown> | undefined;
    return {
      id: row.id,
      version: Number(row.version),
      metadata: JSON.parse(row.metadata_json),
      messages: messages.map((message) => ({
        role: message.role as Message["role"],
        content: String(message.content),
        name: nullableString(message.name),
        toolCallId: nullableString(message.tool_call_id),
        metadata: message.metadata_json ? JSON.parse(String(message.metadata_json)) : undefined,
        createdAt: nullableString(message.created_at),
      })),
      runState: run ? this.loadRun(run) : undefined,
    };
  }

  async save(session: Session, options: SaveSessionOptions = {}): Promise<void> {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.database.prepare("SELECT version FROM sessions WHERE id = ?").get(
        session.id,
      ) as { version: number } | undefined;
      const expected = session.version ?? 0;
      if (!existing) {
        const now = new Date().toISOString();
        this.database.prepare(
          "INSERT INTO sessions (id, version, metadata_json, created_at, updated_at) VALUES (?, 0, ?, ?, ?)",
        ).run(session.id, JSON.stringify(session.metadata), now, now);
      } else if (Number(existing.version) !== expected) {
        throw new SessionVersionConflictError(session.id, expected, Number(existing.version));
      }
      const nextVersion = expected + 1;
      const updated = this.database.prepare(
        `UPDATE sessions SET version = ?, metadata_json = ?, updated_at = ?
         WHERE id = ? AND version = ?`,
      ).run(nextVersion, JSON.stringify(session.metadata), new Date().toISOString(), session.id, expected);
      if (Number(updated.changes) !== 1) {
        const actual = this.database.prepare("SELECT version FROM sessions WHERE id = ?")
          .get(session.id) as { version: number } | undefined;
        throw new SessionVersionConflictError(session.id, expected, Number(actual?.version ?? -1));
      }

      if (options.rewriteMessages) {
        this.database.prepare("DELETE FROM messages WHERE session_id = ?").run(session.id);
      }
      const persistedCount = options.rewriteMessages ? 0 : this.persistedMessageCount(session.id);
      if (persistedCount > session.messages.length) {
        throw new Error(
          `Session ${session.id} message history was shortened without rewriteMessages`,
        );
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
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.database.close();
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
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
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
  }
}

export class SessionVersionConflictError extends Error {
  constructor(sessionId: string, expected: number, actual: number) {
    super(`Session ${sessionId} version conflict: expected ${expected}, found ${actual}`);
    this.name = "SessionVersionConflictError";
  }
}

function nullableString(value: unknown): string | undefined {
  return value == null ? undefined : String(value);
}
