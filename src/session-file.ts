import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { SaveSessionOptions, Session, SessionStore } from "./session.js";

/** Durable store for a single Runtime Service process. */
export class FileSessionStore implements SessionStore {
  private readonly directory: string;
  private readonly cache = new Map<string, Session>();

  constructor(directory: string) {
    this.directory = resolve(directory);
  }

  async getOrCreate(sessionId: string): Promise<Session> {
    const cached = this.cache.get(sessionId);
    if (cached) return cached;
    await mkdir(this.directory, { recursive: true });
    try {
      const raw = await readFile(this.pathFor(sessionId), "utf8");
      const session = JSON.parse(raw) as Session;
      this.cache.set(sessionId, session);
      return session;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const session: Session = { id: sessionId, messages: [], metadata: {} };
      this.cache.set(sessionId, session);
      return session;
    }
  }

  async save(session: Session, _options?: SaveSessionOptions): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const path = this.pathFor(session.id);
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(session, null, 2), "utf8");
    await rename(temporary, path);
    this.cache.set(session.id, session);
  }

  private pathFor(sessionId: string): string {
    return join(this.directory, `${Buffer.from(sessionId).toString("base64url")}.json`);
  }
}
