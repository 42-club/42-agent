import { SqliteSessionStore } from "../session-sqlite.js";
import type { SaveSessionOptions, Session } from "../session.js";
import { StoreLifecycle } from "./lifecycle.js";
import type { ManagedSessionStore } from "./types.js";

/** Managed adapter for the existing single-process SQLite Store. */
export class ManagedSqliteSessionStore implements ManagedSessionStore {
  readonly profile = "sqlite" as const;
  readonly engine = "sqlite" as const;
  readonly namespace: string;

  private readonly store: SqliteSessionStore;
  private readonly lifecycle = new StoreLifecycle();

  constructor(filename: string, namespace: string) {
    this.namespace = namespace;
    this.store = new SqliteSessionStore(filename);
  }

  readinessCheck(): Promise<void> {
    return this.lifecycle.run(async () => {
      await this.store.get("__42_agent_readiness_check__");
    });
  }

  get(sessionId: string): Promise<Session | undefined> {
    return this.lifecycle.run(async () => this.store.get(sessionId));
  }

  create(sessionId: string, metadata?: Record<string, unknown>): Promise<Session> {
    return this.lifecycle.run(async () => this.store.create(sessionId, metadata));
  }

  getOrCreate(sessionId: string): Promise<Session> {
    return this.lifecycle.run(async () => this.store.getOrCreate(sessionId));
  }

  save(session: Session, options?: SaveSessionOptions): Promise<void> {
    return this.lifecycle.run(async () => this.store.save(session, options));
  }

  delete(sessionId: string): Promise<boolean> {
    return this.lifecycle.run(async () => this.store.delete(sessionId));
  }

  close(): Promise<void> {
    return this.lifecycle.close(async () => this.store.close());
  }
}
