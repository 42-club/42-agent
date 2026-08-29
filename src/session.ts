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

export type DeepReadonly<T> = T extends (...arguments_: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

/** Runtime-isolated view exposed to tools without session write capability. */
export type ReadonlySession = DeepReadonly<Session>;

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
  /**
   * Update an existing Session at its current version; never recreate a missing Session.
   * Throw SessionSaveOutcomeUnknownError when durability cannot be determined.
   */
  save(session: Session, options?: SaveSessionOptions): Promise<void>;
  delete(sessionId: string): Promise<boolean>;
}

export interface SaveSessionOptions {
  /**
   * Replace the persisted message history. Without this flag, the existing
   * message prefix is immutable and save may only append messages.
   */
  rewriteMessages?: boolean;
}

/**
 * A save may have reached durable storage even though the Store could not
 * determine its outcome. Callers must reload the Session before any retry.
 */
export class SessionSaveOutcomeUnknownError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SessionSaveOutcomeUnknownError";
  }
}

export class InMemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, Session>();
  private readonly persistedMessages = new Map<string, Message[]>();

  async get(sessionId: string): Promise<Session | undefined> {
    assertValidSessionId(sessionId);
    return this.sessions.get(sessionId);
  }

  async create(sessionId: string, metadata: Record<string, unknown> = {}): Promise<Session> {
    assertValidSessionId(sessionId);
    if (this.sessions.has(sessionId)) throw new SessionAlreadyExistsError(sessionId);
    const session = { id: sessionId, version: 0, messages: [], metadata };
    this.sessions.set(sessionId, session);
    this.persistedMessages.set(sessionId, []);
    return session;
  }

  async getOrCreate(sessionId: string): Promise<Session> {
    assertValidSessionId(sessionId);
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = await this.create(sessionId);
    }
    return session;
  }

  async save(session: Session, options: SaveSessionOptions = {}): Promise<void> {
    assertValidSessionId(session.id);
    const persisted = this.sessions.get(session.id);
    const expected = session.version ?? 0;
    const actual = persisted?.version ?? -1;
    if (!persisted || actual !== expected) {
      throw new SessionVersionConflictError(session.id, expected, actual);
    }
    if (!options.rewriteMessages) {
      assertAppendOnlyMessageHistory(
        session.id,
        this.persistedMessages.get(session.id) ?? [],
        session.messages,
      );
    }
    session.version = expected + 1;
    this.sessions.set(session.id, session);
    this.persistedMessages.set(session.id, structuredClone(session.messages));
  }

  async delete(sessionId: string): Promise<boolean> {
    assertValidSessionId(sessionId);
    this.persistedMessages.delete(sessionId);
    return this.sessions.delete(sessionId);
  }
}

export class SessionAlreadyExistsError extends Error {
  constructor(sessionId: string) {
    super(`Session already exists: ${sessionId}`);
    this.name = "SessionAlreadyExistsError";
  }
}

export class SessionVersionConflictError extends Error {
  constructor(sessionId: string, expected: number, actual: number) {
    super(`Session ${sessionId} version conflict: expected ${expected}, found ${actual}`);
    this.name = "SessionVersionConflictError";
  }
}

export class InvalidSessionIdError extends Error {
  constructor() {
    super("Session ID must be a non-empty, well-formed Unicode string");
    this.name = "InvalidSessionIdError";
  }
}

export class MessageHistoryRewriteRequiredError extends Error {
  constructor(sessionId: string) {
    super(`Session ${sessionId} message history changed without rewriteMessages`);
    this.name = "MessageHistoryRewriteRequiredError";
  }
}

export function assertValidSessionId(sessionId: string): void {
  if (typeof sessionId !== "string"
    || sessionId.length === 0
    || Buffer.from(sessionId, "utf8").toString("utf8") !== sessionId) {
    throw new InvalidSessionIdError();
  }
}

export function assertAppendOnlyMessageHistory(
  sessionId: string,
  persisted: readonly Message[],
  current: readonly Message[],
): void {
  if (persisted.length > current.length) throw new MessageHistoryRewriteRequiredError(sessionId);
  for (let index = 0; index < persisted.length; index += 1) {
    if (JSON.stringify(persisted[index]) !== JSON.stringify(current[index])) {
      throw new MessageHistoryRewriteRequiredError(sessionId);
    }
  }
}

export function createMessage(message: Message): Message {
  return { ...message, createdAt: message.createdAt ?? new Date().toISOString() };
}
