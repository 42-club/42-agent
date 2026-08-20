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
  getOrCreate(sessionId: string): Promise<Session>;
  save(session: Session): Promise<void>;
}

export class InMemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, Session>();

  async getOrCreate(sessionId: string): Promise<Session> {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = { id: sessionId, version: 0, messages: [], metadata: {} };
      this.sessions.set(sessionId, session);
    }
    return session;
  }

  async save(session: Session): Promise<void> {
    session.version = (session.version ?? 0) + 1;
    this.sessions.set(session.id, session);
  }
}

export function createMessage(message: Message): Message {
  return { ...message, createdAt: message.createdAt ?? new Date().toISOString() };
}
