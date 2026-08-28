export type MessageRole = "user" | "assistant" | "system" | "tool";

export interface Message {
  role: MessageRole;
  content: string;
  name?: string;
  toolCallId?: string;
  metadata?: Record<string, unknown>;
  createdAt?: string;
}

export interface Session {
  id: string;
  version?: number;
  messages: Message[];
  metadata: Record<string, unknown>;
  runState?: RunState;
}

export type RunStatus = "running" | "completed" | "failed" | "cancelled" | "interrupted";
export type ToolCallStatus = "pending" | "running" | "completed" | "failed" | "interrupted";

export interface ToolCallState {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  status: ToolCallStatus;
  result?: unknown;
  error?: string;
}

export interface RunState {
  id: string;
  status: RunStatus;
  round: number;
  phase: "model" | "tools" | "idle";
  startedAt: string;
  updatedAt: string;
  toolCalls: ToolCallState[];
  error?: string;
}

export interface SessionStore {
  get(sessionId: string): Promise<Session | undefined>;
  create(sessionId: string, metadata?: Record<string, unknown>): Promise<Session>;
  getOrCreate(sessionId: string): Promise<Session>;
  save(session: Session, options?: SaveSessionOptions): Promise<void>;
  delete(sessionId: string): Promise<boolean>;
}

export interface SaveSessionOptions {
  /** Replace persisted message history. Reserved for operations such as compression. */
  rewriteMessages?: boolean;
}

export class InMemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, Session>();

  async get(sessionId: string): Promise<Session | undefined> {
    return this.sessions.get(sessionId);
  }

  async create(sessionId: string, metadata: Record<string, unknown> = {}): Promise<Session> {
    if (this.sessions.has(sessionId)) throw new SessionAlreadyExistsError(sessionId);
    const session = { id: sessionId, version: 0, messages: [], metadata };
    this.sessions.set(sessionId, session);
    return session;
  }

  async getOrCreate(sessionId: string): Promise<Session> {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = await this.create(sessionId);
    }
    return session;
  }

  async save(session: Session, _options?: SaveSessionOptions): Promise<void> {
    session.version = (session.version ?? 0) + 1;
    this.sessions.set(session.id, session);
  }

  async delete(sessionId: string): Promise<boolean> {
    return this.sessions.delete(sessionId);
  }
}

export class SessionAlreadyExistsError extends Error {
  constructor(sessionId: string) {
    super(`Session already exists: ${sessionId}`);
    this.name = "SessionAlreadyExistsError";
  }
}

export function createMessage(message: Message): Message {
  return { ...message, createdAt: message.createdAt ?? new Date().toISOString() };
}
