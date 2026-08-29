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
  /** Store-protected ownership envelope; generic metadata never grants ownership. */
  ownership?: SessionOwnership;
  runState?: RunState;
}

export interface SessionOwnership {
  version: 1;
  kind: string;
  value: string;
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
  /** True only when create/claim persist protected ownership atomically. */
  readonly supportsSessionOwnership?: true;
  get(sessionId: string): Promise<Session | undefined>;
  create(
    sessionId: string,
    metadata?: Record<string, unknown>,
    options?: SessionCreateOptions,
  ): Promise<Session>;
  getOrCreate(sessionId: string): Promise<Session>;
  /**
   * Update an existing Session at its current version; never recreate a missing Session.
   * Throw SessionSaveOutcomeUnknownError when durability cannot be determined.
   */
  save(session: Session, options?: SaveSessionOptions): Promise<void>;
  delete(sessionId: string): Promise<boolean>;
}

export interface SessionCreateOptions {
  ownership?: SessionOwnership;
}

export interface SaveSessionOptions {
  /**
   * Replace the persisted message history. Without this flag, the existing
   * message prefix is immutable and save may only append messages.
   */
  rewriteMessages?: boolean;
  /** Atomically claim a currently unowned Session with session.ownership. */
  claimOwnership?: boolean;
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
  readonly supportsSessionOwnership = true as const;

  private readonly sessions = new Map<string, Session>();
  private readonly persistedMessages = new Map<string, Message[]>();
  private readonly persistedOwnership = new Map<string, SessionOwnership | undefined>();

  async get(sessionId: string): Promise<Session | undefined> {
    assertValidSessionId(sessionId);
    const session = this.sessions.get(sessionId);
    if (session) restoreSessionOwnership(session, this.persistedOwnership.get(sessionId));
    return session;
  }

  async create(
    sessionId: string,
    metadata: Record<string, unknown> = {},
    options: SessionCreateOptions = {},
  ): Promise<Session> {
    assertValidSessionId(sessionId);
    if (this.sessions.has(sessionId)) throw new SessionAlreadyExistsError(sessionId);
    const ownership = snapshotSessionOwnership(options.ownership);
    const session: Session = {
      id: sessionId,
      version: 0,
      messages: [],
      metadata,
      ...(ownership ? { ownership } : {}),
    };
    this.sessions.set(sessionId, session);
    this.persistedMessages.set(sessionId, []);
    this.persistedOwnership.set(sessionId, snapshotSessionOwnership(ownership));
    return session;
  }

  async getOrCreate(sessionId: string): Promise<Session> {
    assertValidSessionId(sessionId);
    let session = await this.get(sessionId);
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
    const ownership = resolveSessionOwnershipSave(
      session.id,
      this.persistedOwnership.get(session.id),
      session.ownership,
      options.claimOwnership === true,
    );
    if (!options.rewriteMessages) {
      assertAppendOnlyMessageHistory(
        session.id,
        this.persistedMessages.get(session.id) ?? [],
        session.messages,
      );
    }
    session.version = expected + 1;
    restoreSessionOwnership(session, ownership);
    this.sessions.set(session.id, session);
    this.persistedMessages.set(session.id, structuredClone(session.messages));
    this.persistedOwnership.set(session.id, snapshotSessionOwnership(ownership));
  }

  async delete(sessionId: string): Promise<boolean> {
    assertValidSessionId(sessionId);
    this.persistedMessages.delete(sessionId);
    this.persistedOwnership.delete(sessionId);
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
    super("Session ID must be a non-empty, NUL-free, well-formed Unicode string");
    this.name = "InvalidSessionIdError";
  }
}

export class MessageHistoryRewriteRequiredError extends Error {
  constructor(sessionId: string) {
    super(`Session ${sessionId} message history changed without rewriteMessages`);
    this.name = "MessageHistoryRewriteRequiredError";
  }
}

export class InvalidSessionOwnershipError extends Error {
  constructor() {
    super(
      "Session ownership must be an exact version 1 envelope with non-empty, NUL-free, well-formed Unicode kind and value",
    );
    this.name = "InvalidSessionOwnershipError";
  }
}

export class SessionOwnershipConflictError extends Error {
  constructor(sessionId: string) {
    super(`Session ${sessionId} ownership is immutable or has already been claimed`);
    this.name = "SessionOwnershipConflictError";
  }
}

export function assertValidSessionId(sessionId: string): void {
  if (typeof sessionId !== "string"
    || sessionId.length === 0
    || sessionId.includes("\0")
    || Buffer.from(sessionId, "utf8").toString("utf8") !== sessionId) {
    throw new InvalidSessionIdError();
  }
}

/** Validate and detach a protected ownership envelope from caller-controlled objects. */
export function snapshotSessionOwnership(value: unknown): SessionOwnership | undefined {
  if (value === undefined) return undefined;
  const keys = typeof value === "object" && value !== null && !Array.isArray(value)
    ? Reflect.ownKeys(value)
    : [];
  if (typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || keys.length !== 3
    || keys.some((key) => key !== "version" && key !== "kind" && key !== "value")
    || !Object.hasOwn(value, "version")
    || !Object.hasOwn(value, "kind")
    || !Object.hasOwn(value, "value")) {
    throw new InvalidSessionOwnershipError();
  }
  const ownership = value as Record<string, unknown>;
  if (ownership.version !== 1
    || !isValidOwnershipString(ownership.kind)
    || !isValidOwnershipString(ownership.value)) {
    throw new InvalidSessionOwnershipError();
  }
  return { version: 1, kind: ownership.kind, value: ownership.value };
}

/** Resolve one immutable ownership transition against the Store's authoritative snapshot. */
export function resolveSessionOwnershipSave(
  sessionId: string,
  persistedValue: unknown,
  currentValue: unknown,
  claimOwnership = false,
): SessionOwnership | undefined {
  const persisted = snapshotSessionOwnership(persistedValue);
  const current = snapshotSessionOwnership(currentValue);
  if (claimOwnership) {
    if (persisted !== undefined || current === undefined) {
      throw new SessionOwnershipConflictError(sessionId);
    }
    return current;
  }
  if (!sameSessionOwnership(persisted, current)) {
    throw new SessionOwnershipConflictError(sessionId);
  }
  return current;
}

/** Restore protected ownership onto a cached live Session from authoritative storage. */
export function restoreSessionOwnership(session: Session, value: unknown): void {
  const ownership = snapshotSessionOwnership(value);
  if (ownership) session.ownership = ownership;
  else delete session.ownership;
}

function sameSessionOwnership(
  left: SessionOwnership | undefined,
  right: SessionOwnership | undefined,
): boolean {
  return left === undefined
    ? right === undefined
    : right !== undefined
      && left.version === right.version
      && left.kind === right.kind
      && left.value === right.value;
}

function isValidOwnershipString(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && !value.includes("\0")
    && Buffer.from(value, "utf8").toString("utf8") === value;
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
