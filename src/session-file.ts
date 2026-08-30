import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  assertAppendOnlyMessageHistory,
  assertValidSessionId,
  resolveSessionOwnershipSave,
  restoreSessionOwnership,
  SessionAlreadyExistsError,
  SessionVersionConflictError,
  snapshotSessionOwnership,
  type SaveSessionOptions,
  type Session,
  type SessionCreateOptions,
  type SessionOwnership,
  type SessionStore,
} from "./session.js";

const FILE_SESSION_CONTAINER_TAG = "$42-agent.file-session";
const FILE_SESSION_CONTAINER_VERSION = 1;
// JSON.stringify always emits a complete JSON value, so the legacy raw-Session
// writer cannot produce this non-JSON framing prefix, even through toJSON.
const FILE_SESSION_CONTAINER_MAGIC = "42-agent:file-session:v1\n";

/** Durable store for a single Runtime Service process. */
export class FileSessionStore implements SessionStore {
  readonly supportsSessionOwnership = true as const;

  private static readonly operationQueues = new Map<string, Promise<void>>();

  private readonly directory: string;
  private readonly cache = new Map<string, Session>();

  constructor(directory: string) {
    this.directory = resolve(directory);
  }

  async get(sessionId: string): Promise<Session | undefined> {
    return this.enqueue(sessionId, async () => this.load(sessionId));
  }

  async create(
    sessionId: string,
    metadata: Record<string, unknown> = {},
    options: SessionCreateOptions = {},
  ): Promise<Session> {
    return this.enqueue(
      sessionId,
      async () => this.createExclusive(sessionId, metadata, options),
    );
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
        const ownership = resolveSessionOwnershipSave(
          session.id,
          persisted.ownership,
          session.ownership,
          options.claimOwnership === true,
        );
        if (!options.rewriteMessages) {
          assertAppendOnlyMessageHistory(session.id, persisted.messages, session.messages);
        }

        const nextVersion = expectedVersion + 1;
        const snapshot: Session = { ...session, version: nextVersion };
        restoreSessionOwnership(snapshot, ownership);
        await this.replaceAtomically(
          this.pathFor(session.id),
          serializePersistedSession(snapshot, ownership),
        );
        session.version = nextVersion;
        restoreSessionOwnership(session, ownership);
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
    if (cached && (cached.version ?? 0) === (persisted.version ?? 0)) {
      restoreSessionOwnership(cached, persisted.ownership);
      return cached;
    }
    this.cache.set(sessionId, persisted);
    return persisted;
  }

  private async readPersisted(sessionId: string): Promise<Session | undefined> {
    try {
      const raw = await readFile(this.pathFor(sessionId), "utf8");
      const isProtectedContainer = raw.startsWith(FILE_SESSION_CONTAINER_MAGIC);
      const parsed: unknown = JSON.parse(isProtectedContainer
        ? raw.slice(FILE_SESSION_CONTAINER_MAGIC.length)
        : raw);
      const container = isProtectedContainer ? parseSessionContainer(parsed) : undefined;
      const session = container?.session ?? parseLegacySession(parsed);
      if (session.id !== sessionId) throw new SessionPathCollisionError(sessionId);
      restoreSessionOwnership(session, container?.ownership);
      return session;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  private async createExclusive(
    sessionId: string,
    metadata: Record<string, unknown>,
    options: SessionCreateOptions = {},
  ): Promise<Session> {
    await mkdir(this.directory, { recursive: true });
    const ownership = snapshotSessionOwnership(options.ownership);
    const session: Session = {
      id: sessionId,
      version: 0,
      messages: [],
      metadata,
      ...(ownership ? { ownership } : {}),
    };
    try {
      await writeFile(this.pathFor(sessionId), serializePersistedSession(session, ownership), {
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

interface PersistedSessionContainer {
  readonly session: Session;
  readonly ownership?: SessionOwnership;
}

function serializePersistedSession(
  session: Session,
  ownership: SessionOwnership | undefined,
): string {
  const nestedSession: Session = { ...session };
  delete nestedSession.ownership;
  delete (nestedSession as unknown as Record<string, unknown>).toJSON;
  return FILE_SESSION_CONTAINER_MAGIC + JSON.stringify({
    [FILE_SESSION_CONTAINER_TAG]: FILE_SESSION_CONTAINER_VERSION,
    session: nestedSession,
    ...(ownership ? { ownership: snapshotSessionOwnership(ownership) } : {}),
  }, null, 2);
}

function parseSessionContainer(value: unknown): PersistedSessionContainer {
  if (!isRecord(value)) throw new TypeError("Invalid protected File Session container");
  const hasOwnership = Object.hasOwn(value, "ownership");
  const expectedKeys = hasOwnership
    ? [FILE_SESSION_CONTAINER_TAG, "session", "ownership"]
    : [FILE_SESSION_CONTAINER_TAG, "session"];
  const keys = Reflect.ownKeys(value);
  if (keys.length !== expectedKeys.length
    || keys.some((key) => typeof key !== "string" || !expectedKeys.includes(key))
    || value[FILE_SESSION_CONTAINER_TAG] !== FILE_SESSION_CONTAINER_VERSION
    || !isRecord(value.session)
    || Object.hasOwn(value.session, "ownership")) {
    throw new TypeError("Invalid protected File Session container");
  }
  return {
    session: value.session as unknown as Session,
    ownership: hasOwnership
      ? snapshotSessionOwnership(value.ownership)
      : undefined,
  };
}

function parseLegacySession(value: unknown): Session {
  if (!isRecord(value)) throw new TypeError("File Session must be a JSON object");
  // The legacy writer persisted a raw, caller-controlled Session object. Its
  // top-level ownership key has no protected provenance, even when it happens
  // to contain an exact current envelope.
  delete value.ownership;
  return value as unknown as Session;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
