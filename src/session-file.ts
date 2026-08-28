import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  assertAppendOnlyMessageHistory,
  assertValidSessionId,
  SessionAlreadyExistsError,
  SessionVersionConflictError,
  type SaveSessionOptions,
  type Session,
  type SessionStore,
} from "./session.js";

/** Durable store for a single Runtime Service process. */
export class FileSessionStore implements SessionStore {
  private static readonly operationQueues = new Map<string, Promise<void>>();

  private readonly directory: string;
  private readonly cache = new Map<string, Session>();

  constructor(directory: string) {
    this.directory = resolve(directory);
  }

  async get(sessionId: string): Promise<Session | undefined> {
    return this.enqueue(sessionId, async () => this.load(sessionId));
  }

  async create(sessionId: string, metadata: Record<string, unknown> = {}): Promise<Session> {
    return this.enqueue(sessionId, async () => this.createExclusive(sessionId, metadata));
  }

  async getOrCreate(sessionId: string): Promise<Session> {
    return this.enqueue(sessionId, async () => {
      const existing = await this.load(sessionId);
      if (existing) return existing;
      try {
        return await this.createExclusive(sessionId, {});
      } catch (error) {
        // Another process can win between the read and the exclusive create.
        if (!(error instanceof SessionAlreadyExistsError)) throw error;
        const created = await this.load(sessionId);
        if (created) return created;
        throw error;
      }
    });
  }

  async save(session: Session, options: SaveSessionOptions = {}): Promise<void> {
    try {
      await this.enqueue(session.id, async () => {
        await mkdir(this.directory, { recursive: true });
        const persisted = await this.readPersisted(session.id);
        if (!persisted) {
          this.cache.delete(session.id);
          throw new SessionVersionConflictError(session.id, session.version ?? 0, -1);
        }

        const expectedVersion = session.version ?? 0;
        const actualVersion = persisted.version ?? 0;
        if (actualVersion !== expectedVersion) {
          throw new SessionVersionConflictError(session.id, expectedVersion, actualVersion);
        }
        if (!options.rewriteMessages) {
          assertAppendOnlyMessageHistory(session.id, persisted.messages, session.messages);
        }

        const nextVersion = expectedVersion + 1;
        const snapshot: Session = { ...session, version: nextVersion };
        await this.replaceAtomically(this.pathFor(session.id), JSON.stringify(snapshot, null, 2));
        session.version = nextVersion;
        this.cache.set(session.id, session);
      });
    } catch (error) {
      // A cached live object may have been mutated before a failed checkpoint.
      // Evict it so subsequent reads reflect only the durable file.
      this.cache.delete(session.id);
      throw error;
    }
  }

  async delete(sessionId: string): Promise<boolean> {
    return this.enqueue(sessionId, async () => {
      this.cache.delete(sessionId);
      try {
        const persisted = await this.readPersisted(sessionId);
        if (!persisted) return false;
        await unlink(this.pathFor(sessionId));
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
    });
  }

  private async load(sessionId: string): Promise<Session | undefined> {
    const persisted = await this.readPersisted(sessionId);
    if (!persisted) {
      this.cache.delete(sessionId);
      return undefined;
    }
    const cached = this.cache.get(sessionId);
    if (cached && (cached.version ?? 0) === (persisted.version ?? 0)) return cached;
    this.cache.set(sessionId, persisted);
    return persisted;
  }

  private async readPersisted(sessionId: string): Promise<Session | undefined> {
    try {
      const raw = await readFile(this.pathFor(sessionId), "utf8");
      const session = JSON.parse(raw) as Session;
      if (session.id !== sessionId) throw new SessionPathCollisionError(sessionId);
      return session;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  private async createExclusive(
    sessionId: string,
    metadata: Record<string, unknown>,
  ): Promise<Session> {
    await mkdir(this.directory, { recursive: true });
    const session: Session = { id: sessionId, version: 0, messages: [], metadata };
    try {
      await writeFile(this.pathFor(sessionId), JSON.stringify(session, null, 2), {
        encoding: "utf8",
        flag: "wx",
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        // Never translate a digest collision into another Session's state.
        await this.readPersisted(sessionId);
        throw new SessionAlreadyExistsError(sessionId);
      }
      throw error;
    }
    this.cache.set(sessionId, session);
    return session;
  }

  private async replaceAtomically(path: string, contents: string): Promise<void> {
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, contents, { encoding: "utf8", flag: "wx" });
      await rename(temporary, path);
    } catch (error) {
      try {
        await unlink(temporary);
      } catch (cleanupError) {
        if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") throw cleanupError;
      }
      throw error;
    }
  }

  private enqueue<Result>(sessionId: string, operation: () => Promise<Result>): Promise<Result> {
    const key = this.pathFor(sessionId);
    const previous = FileSessionStore.operationQueues.get(key) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const tail = result.then(() => undefined, () => undefined);
    FileSessionStore.operationQueues.set(key, tail);
    return result.finally(() => {
      if (FileSessionStore.operationQueues.get(key) === tail) {
        FileSessionStore.operationQueues.delete(key);
      }
    });
  }

  private pathFor(sessionId: string): string {
    assertValidSessionId(sessionId);
    // A fixed lowercase digest avoids case-folding aliases and filesystem
    // component-length limits. Every read verifies the stored canonical ID, so
    // even a digest collision can never return or delete another Session.
    const digest = createHash("sha256").update(sessionId, "utf8").digest("hex");
    return join(this.directory, `${digest}.json`);
  }
}

export class SessionPathCollisionError extends Error {
  constructor(sessionId: string) {
    super(`File Session path collision for ID: ${sessionId}`);
    this.name = "SessionPathCollisionError";
  }
}
