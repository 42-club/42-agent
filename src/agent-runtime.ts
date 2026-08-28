import { randomUUID } from "node:crypto";
import type { AgentLoop, RecoveryResult } from "./agent-loop.js";
import type { AgentLoopEvent, AgentLoopEventHandler } from "./runtime/events.js";
import { assertValidSessionId, SessionAlreadyExistsError, type Session, type SessionStore } from "./session.js";
import type { SkillCatalog, SkillDescriptor, SkillLoader } from "./skills.js";
import type { ToolDescriptor, ToolRegistry } from "./tools/base.js";

export interface TextContentPart {
  type: "text";
  text: string;
}

export type RuntimeContentPart = TextContentPart;
export type RuntimeStopReason = "end_turn" | "cancelled" | "error";

export interface CreateSessionInput {
  sessionId?: string;
  skills?: readonly string[];
  tools?: readonly string[];
  metadata?: Record<string, unknown>;
}

export interface SessionInfo {
  sessionId: string;
  created: boolean;
  metadata: Record<string, unknown>;
  skills: readonly string[];
  tools: readonly string[];
  activeRunIds: readonly string[];
}

export interface PromptInput {
  sessionId: string;
  content: readonly RuntimeContentPart[];
  /** Allow protocol adapters to atomically admit a turn that starts a new session. */
  createIfMissing?: boolean;
  skills?: readonly string[];
  tools?: readonly string[];
  promptInjections?: readonly string[];
  metadata?: Record<string, unknown>;
  signal?: AbortSignal;
  onEvent?: AgentLoopEventHandler;
}

export interface TurnResult {
  sessionId: string;
  runId: string;
  stopReason: RuntimeStopReason;
  content: readonly RuntimeContentPart[];
}

export interface ActiveRunInfo {
  sessionId: string;
  runId?: string;
  status: "queued" | "running";
}

export interface RuntimeCapabilities {
  contentTypes: readonly RuntimeContentPart["type"][];
  streaming: boolean;
  cancellation: boolean;
  steering: boolean;
  sessionResume: boolean;
  tools: readonly ToolDescriptor[];
  skills: readonly SkillDescriptor[];
}

export interface AgentRuntimeDependencies {
  loop: AgentLoop;
  /** @deprecated Omit this; AgentRuntime derives the canonical store from loop. */
  sessionStore?: SessionStore;
  /** @deprecated Omit this; AgentRuntime derives the canonical registry from loop. */
  tools?: ToolRegistry;
  /** @deprecated Omit this; AgentRuntime derives the canonical loader from loop. */
  skills?: SkillCatalog;
  onEvent?: AgentLoopEventHandler;
}

interface ResolvedAgentRuntimeDependencies {
  loop: AgentLoop;
  sessionStore: SessionStore;
  tools: ToolRegistry;
  skillLoader?: SkillLoader;
  skills?: SkillCatalog;
  onEvent?: AgentLoopEventHandler;
}

interface ActiveRun {
  controller: AbortController;
  runId?: string;
  status: "queued" | "running";
  terminal: boolean;
  settled: Promise<void>;
  resolveSettled: () => void;
  detachSignal?: () => void;
}

interface PendingSessionOperation {
  settled: Promise<void>;
  resolveSettled: () => void;
}

const SESSION_SKILLS = "runtime.skills";
const SESSION_TOOLS = "runtime.tools";

/** Protocol-neutral lifecycle facade used by ACP, HTTP, CLI, and embedded hosts. */
export class AgentRuntime {
  private readonly dependencies: ResolvedAgentRuntimeDependencies;
  private readonly active = new Map<string, Set<ActiveRun>>();
  private readonly sessionOperations = new Map<string, Set<PendingSessionOperation>>();
  private readonly closingSessions = new Map<string, Promise<boolean>>();
  private started = false;
  private closed = false;
  private closing?: Promise<void>;

  constructor(dependencies: AgentRuntimeDependencies) {
    const sessionStore = dependencies.loop.sessionStore;
    const tools = dependencies.loop.toolRegistry;
    if (dependencies.sessionStore && dependencies.sessionStore !== sessionStore) {
      throw new RuntimeDependencyMismatchError("sessionStore");
    }
    if (dependencies.tools && dependencies.tools !== tools) {
      throw new RuntimeDependencyMismatchError("tools");
    }
    const skillLoader = dependencies.loop.skillLoader;
    if (dependencies.skills && dependencies.skills !== skillLoader) {
      throw new RuntimeDependencyMismatchError("skills");
    }
    this.dependencies = {
      loop: dependencies.loop,
      sessionStore,
      tools,
      skillLoader,
      skills: isSkillCatalog(skillLoader) ? skillLoader : undefined,
      onEvent: dependencies.onEvent,
    };
  }

  async start(): Promise<void> {
    if (this.closed) throw new RuntimeClosedError();
    this.started = true;
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    if (this.closed) return Promise.resolve();
    this.closed = true;
    // Publish the shared shutdown promise before abort listeners can re-enter
    // close(); finishClose begins on the next microtask.
    this.closing = Promise.resolve().then(() => this.finishClose());
    return this.closing;
  }

  private async finishClose(): Promise<void> {
    const pending = [...this.active.values()].flatMap((runs) => [...runs]);
    const operations = [...this.sessionOperations.values()].flatMap((items) => [...items]);
    const closings = [...this.closingSessions.values()];
    for (const runs of this.active.values()) {
      for (const run of runs) run.controller.abort(new DOMException("Runtime closed", "AbortError"));
    }
    await Promise.allSettled([
      ...pending.map((run) => run.settled),
      ...operations.map((operation) => operation.settled),
      ...closings,
    ]);
  }

  async capabilities(): Promise<RuntimeCapabilities> {
    return {
      contentTypes: ["text"],
      streaming: true,
      cancellation: true,
      steering: true,
      sessionResume: true,
      tools: structuredClone(this.dependencies.tools.descriptors()),
      skills: structuredClone(await this.dependencies.skills?.list() ?? []),
    };
  }

  async createSession(input: CreateSessionInput = {}): Promise<SessionInfo> {
    this.assertAvailable();
    const request = snapshotCreateSessionInput(input);
    const sessionId = request.sessionId ?? randomUUID();
    assertValidSessionId(sessionId);
    const operation = this.beginSessionOperation(sessionId);
    try {
      await this.validateSelection(request.tools, request.skills);
      const metadata = sessionMetadata(request);
      const session = await this.dependencies.sessionStore.create(sessionId, metadata);
      return this.toSessionInfo(session, true);
    } finally {
      this.endSessionOperation(sessionId, operation);
    }
  }

  async resumeSession(sessionId: string): Promise<SessionInfo> {
    this.assertAvailable();
    assertValidSessionId(sessionId);
    const operation = this.beginSessionOperation(sessionId);
    try {
      const session = await this.requireSession(sessionId);
      return this.toSessionInfo(session, false);
    } finally {
      this.endSessionOperation(sessionId, operation);
    }
  }

  async getSession(sessionId: string): Promise<SessionInfo | undefined> {
    this.assertAvailable();
    assertValidSessionId(sessionId);
    const operation = this.beginSessionOperation(sessionId);
    try {
      const session = await this.dependencies.sessionStore.get(sessionId);
      return session ? this.toSessionInfo(session, false) : undefined;
    } finally {
      this.endSessionOperation(sessionId, operation);
    }
  }

  async closeSession(sessionId: string): Promise<boolean> {
    this.assertAvailable();
    assertValidSessionId(sessionId);
    const existing = this.closingSessions.get(sessionId);
    if (existing) return existing;

    let resolveClose!: (deleted: boolean) => void;
    let rejectClose!: (error: unknown) => void;
    const closing = new Promise<boolean>((resolve, reject) => {
      resolveClose = resolve;
      rejectClose = reject;
    });
    // Publish the gate before aborting. Abort listeners run synchronously and may
    // otherwise admit a re-entrant prompt while the session is being closed.
    this.closingSessions.set(sessionId, closing);
    void this.finishCloseSession(sessionId).then((deleted) => {
      if (this.closingSessions.get(sessionId) === closing) {
        this.closingSessions.delete(sessionId);
      }
      resolveClose(deleted);
    }, (error) => {
      if (this.closingSessions.get(sessionId) === closing) {
        this.closingSessions.delete(sessionId);
      }
      rejectClose(error);
    });
    return closing;
  }

  async prompt(input: PromptInput): Promise<TurnResult> {
    this.assertAvailable();
    const request = snapshotPromptInput(input);
    assertValidSessionId(request.sessionId);
    this.assertSessionNotClosing(request.sessionId);

    const controller = new AbortController();
    let resolveSettled!: () => void;
    const settled = new Promise<void>((resolve) => { resolveSettled = resolve; });
    const active: ActiveRun = {
      controller,
      status: "queued",
      terminal: false,
      settled,
      resolveSettled,
    };
    if (request.signal) {
      const abort = () => controller.abort(request.signal?.reason);
      if (request.signal.aborted) abort();
      else request.signal.addEventListener("abort", abort, { once: true });
      active.detachSignal = () => request.signal?.removeEventListener("abort", abort);
    }
    const runs = this.active.get(request.sessionId) ?? new Set<ActiveRun>();
    runs.add(active);
    this.active.set(request.sessionId, runs);

    try {
      const session = await this.resolvePromptSession(request);
      const sessionTools = readStringList(session.metadata[SESSION_TOOLS]);
      const sessionSkills = readStringList(session.metadata[SESSION_SKILLS]);
      const tools = selectWithinSession("tool", request.tools, sessionTools);
      const skills = selectWithinSession("skill", request.skills, sessionSkills);
      await this.validateSelection(tools, skills);

      const result = await this.dependencies.loop.runTurnDetailed({
        sessionId: request.sessionId,
        userInput: joinText(request.content),
        promptInjections: request.promptInjections,
        skills,
        tools,
        signal: controller.signal,
        onEvent: (event) => {
          if (event.type === "run_started") {
            active.runId = event.runId;
            active.status = "running";
          } else if (event.type === "run_completed"
            || event.type === "run_failed"
            || event.type === "run_cancelled") {
            // Close external control admission before terminal observers run.
            active.terminal = true;
          }
          notifyObserver(this.dependencies.onEvent, event);
          notifyObserver(request.onEvent, event);
        },
      });
      return {
        sessionId: result.sessionId,
        runId: result.runId,
        stopReason: result.stopReason,
        content: [{ type: "text", text: result.content }],
      };
    } finally {
      active.detachSignal?.();
      runs.delete(active);
      if (runs.size === 0) this.active.delete(request.sessionId);
      active.resolveSettled();
    }
  }

  cancel(sessionId: string, reason = "Cancelled by client"): boolean {
    const runs = this.active.get(sessionId);
    const cancellable = [...(runs ?? [])].filter(
      (run) => !run.terminal && !run.controller.signal.aborted,
    );
    if (cancellable.length === 0) return false;
    for (const run of cancellable) {
      run.controller.abort(new DOMException(reason, "AbortError"));
    }
    this.dependencies.loop.clearSteering(sessionId);
    return true;
  }

  steer(sessionId: string, message: string): boolean {
    const runs = this.active.get(sessionId);
    if (![...(runs ?? [])].some(
      (run) => !run.terminal && !run.controller.signal.aborted,
    )) return false;
    return this.dependencies.loop.steer(sessionId, message);
  }

  activeRuns(sessionId: string): readonly ActiveRunInfo[] {
    return [...(this.active.get(sessionId) ?? [])].filter((run) => !run.terminal).map((run) => ({
      sessionId,
      runId: run.runId,
      status: run.status,
    }));
  }

  async recoverSession(sessionId: string): Promise<RecoveryResult> {
    this.assertAvailable();
    assertValidSessionId(sessionId);
    const operation = this.beginSessionOperation(sessionId);
    try {
      await this.requireSession(sessionId);
      return await this.dependencies.loop.recoverSession(sessionId);
    } finally {
      this.endSessionOperation(sessionId, operation);
    }
  }

  private assertAvailable(): void {
    if (this.closed) throw new RuntimeClosedError();
    if (!this.started) this.started = true;
  }

  private assertSessionNotClosing(sessionId: string): void {
    if (this.closingSessions.has(sessionId)) throw new SessionClosingError(sessionId);
  }

  private async finishCloseSession(sessionId: string): Promise<boolean> {
    const pending = [...(this.active.get(sessionId) ?? [])];
    const operations = [...(this.sessionOperations.get(sessionId) ?? [])];
    this.cancel(sessionId, "Session closed");
    await Promise.allSettled([
      ...pending.map((run) => run.settled),
      ...operations.map((operation) => operation.settled),
    ]);
    return this.dependencies.sessionStore.delete(sessionId);
  }

  private beginSessionOperation(sessionId: string): PendingSessionOperation {
    this.assertSessionNotClosing(sessionId);
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => { settle = resolve; });
    const operation: PendingSessionOperation = {
      settled,
      resolveSettled: settle,
    };
    const operations = this.sessionOperations.get(sessionId) ?? new Set<PendingSessionOperation>();
    operations.add(operation);
    this.sessionOperations.set(sessionId, operations);
    return operation;
  }

  private endSessionOperation(sessionId: string, operation: PendingSessionOperation): void {
    const operations = this.sessionOperations.get(sessionId);
    operations?.delete(operation);
    if (operations?.size === 0) this.sessionOperations.delete(sessionId);
    operation.resolveSettled();
  }

  private async resolvePromptSession(input: PromptInput): Promise<Session> {
    const existing = await this.dependencies.sessionStore.get(input.sessionId);
    if (existing) return existing;
    if (!input.createIfMissing) throw new SessionNotFoundError(input.sessionId);

    await this.validateSelection(input.tools, input.skills);
    try {
      return await this.dependencies.sessionStore.create(
        input.sessionId,
        sessionMetadata(input),
      );
    } catch (error) {
      // Two adapters may admit the first turn concurrently. Whichever loses the
      // create race joins the same runtime-serialized session.
      if (!(error instanceof SessionAlreadyExistsError)) throw error;
      return this.requireSession(input.sessionId);
    }
  }

  private async requireSession(sessionId: string): Promise<Session> {
    const session = await this.dependencies.sessionStore.get(sessionId);
    if (!session) throw new SessionNotFoundError(sessionId);
    return session;
  }

  private async validateSelection(
    tools?: readonly string[],
    skills?: readonly string[],
  ): Promise<void> {
    assertUniqueSelection("tool", tools);
    assertUniqueSelection("skill", skills);
    for (const name of tools ?? []) this.dependencies.tools.get(name);
    if (skills?.length) {
      if (!this.dependencies.skillLoader) throw new Error("No SkillLoader configured");
      await this.dependencies.skillLoader.load(skills);
    }
  }

  private toSessionInfo(session: Session, created: boolean): SessionInfo {
    const metadata = structuredClone(session.metadata);
    return {
      sessionId: session.id,
      created,
      metadata,
      skills: [...(readStringList(metadata[SESSION_SKILLS]) ?? [])],
      tools: [...(readStringList(metadata[SESSION_TOOLS]) ?? [])],
      activeRunIds: this.activeRuns(session.id)
        .map((run) => run.runId)
        .filter((runId): runId is string => Boolean(runId)),
    };
  }
}

export class SessionNotFoundError extends Error {
  constructor(sessionId: string) {
    super(`Session not found: ${sessionId}`);
    this.name = "SessionNotFoundError";
  }
}

export class RuntimeClosedError extends Error {
  constructor() {
    super("AgentRuntime is closed");
    this.name = "RuntimeClosedError";
  }
}

export class SessionClosingError extends Error {
  constructor(sessionId: string) {
    super(`Session is closing: ${sessionId}`);
    this.name = "SessionClosingError";
  }
}

export class RuntimeDependencyMismatchError extends Error {
  constructor(dependency: "sessionStore" | "tools" | "skills") {
    super(`AgentRuntime ${dependency} must be the same instance used by AgentLoop`);
    this.name = "RuntimeDependencyMismatchError";
  }
}

function isSkillCatalog(loader: SkillLoader | undefined): loader is SkillCatalog {
  return loader !== undefined
    && "list" in loader
    && typeof (loader as { list?: unknown }).list === "function";
}

function joinText(content: readonly RuntimeContentPart[]): string {
  if (content.length === 0) throw new Error("Prompt content is required");
  return content.map((part) => part.text).join("");
}

function readStringList(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : undefined;
}

function selectWithinSession(
  kind: "tool" | "skill",
  requested?: readonly string[],
  allowed?: readonly string[],
): readonly string[] | undefined {
  if (!requested) return allowed;
  if (!allowed) return requested;
  const allowedSet = new Set(allowed);
  const denied = requested.find((name) => !allowedSet.has(name));
  if (denied) throw new Error(`Requested ${kind} is not allowed by the session: ${denied}`);
  return requested;
}

function sessionMetadata(input: Pick<CreateSessionInput, "metadata" | "skills" | "tools">): Record<string, unknown> {
  const metadata = structuredClone(input.metadata ?? {});
  delete metadata[SESSION_TOOLS];
  delete metadata[SESSION_SKILLS];
  return {
    ...metadata,
    ...(input.tools ? { [SESSION_TOOLS]: [...input.tools] } : {}),
    ...(input.skills ? { [SESSION_SKILLS]: [...input.skills] } : {}),
  };
}

function snapshotCreateSessionInput(input: CreateSessionInput): CreateSessionInput {
  return {
    sessionId: input.sessionId,
    tools: input.tools ? [...input.tools] : undefined,
    skills: input.skills ? [...input.skills] : undefined,
    metadata: structuredClone(input.metadata),
  };
}

function snapshotPromptInput(input: PromptInput): PromptInput {
  return {
    sessionId: input.sessionId,
    content: structuredClone(input.content),
    createIfMissing: input.createIfMissing,
    tools: input.tools ? [...input.tools] : undefined,
    skills: input.skills ? [...input.skills] : undefined,
    promptInjections: input.promptInjections ? [...input.promptInjections] : undefined,
    metadata: structuredClone(input.metadata),
    signal: input.signal,
    onEvent: input.onEvent,
  };
}

function assertUniqueSelection(
  kind: "tool" | "skill",
  names: readonly string[] | undefined,
): void {
  const seen = new Set<string>();
  for (const name of names ?? []) {
    if (seen.has(name)) throw new Error(`Duplicate ${kind} capability: ${name}`);
    seen.add(name);
  }
}

function notifyObserver(
  handler: AgentLoopEventHandler | undefined,
  event: AgentLoopEvent,
): void {
  if (!handler) return;
  try {
    void Promise.resolve(handler(event)).catch(() => undefined);
  } catch {
    // Observer delivery is best-effort and cannot affect canonical run state.
  }
}
