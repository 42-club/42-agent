import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { SessionAlreadyExistsError, type SaveSessionOptions, type Session, type SessionStore } from "./session.js";

/** Durable store for a single Runtime Service process. */
export class FileSessionStore implements SessionStore {
  private readonly directory: string;
  private readonly cache = new Map<string, Session>();

  constructor(directory: string) {
    this.directory = resolve(directory);
  }

  async get(sessionId: string): Promise<Session | undefined> {
    const cached = this.cache.get(sessionId);
    if (cached) return cached;
    await mkdir(this.directory, { recursive: true });
    try {
      const raw = await readFile(this.pathFor(sessionId), "utf8");
      const session = JSON.parse(raw) as Session;
      this.cache.set(sessionId, session);
      return session;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async create(sessionId: string, metadata: Record<string, unknown> = {}): Promise<Session> {
    if (await this.get(sessionId)) throw new SessionAlreadyExistsError(sessionId);
    const session: Session = { id: sessionId, version: 0, messages: [], metadata };
    await this.save(session);
    return session;
  }

  async getOrCreate(sessionId: string): Promise<Session> {
    return (await this.get(sessionId)) ?? this.create(sessionId);
  }

  async save(session: Session, _options?: SaveSessionOptions): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const path = this.pathFor(session.id);
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(session, null, 2), "utf8");
    await rename(temporary, path);
    this.cache.set(session.id, session);
  }

  async delete(sessionId: string): Promise<boolean> {
    this.cache.delete(sessionId);
    try {
      await unlink(this.pathFor(sessionId));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  private pathFor(sessionId: string): string {
    return join(this.directory, `${Buffer.from(sessionId).toString("base64url")}.json`);
  }
}
