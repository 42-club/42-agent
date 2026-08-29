import { randomUUID } from "node:crypto";
import type {
  AgentLoop,
  PreparedSkillSelection,
  RecoveryResult,
} from "./agent-loop.js";
import type { AgentLoopEvent, AgentLoopEventHandler } from "./runtime/events.js";
import { throwIfAborted } from "./runtime/retry.js";
import {
  assertValidSessionId,
  SessionAlreadyExistsError,
  snapshotSessionOwnership,
  type Session,
  type SessionOwnership,
  type SessionStore,
} from "./session.js";
import type { SkillCatalog, SkillDescriptor, SkillLoader } from "./skills.js";
import type { ToolDescriptor, ToolRegistry } from "./tools/base.js";

export interface TextContentPart {
  type: "text";
  text: string;
}

export type RuntimeContentPart = TextContentPart;
/** Successful Runtime Turns resolve only after reaching the canonical end-turn state. */
export type RuntimeStopReason = "end_turn";

/** Protocol-neutral ownership token assigned by a trusted session adapter. */
export interface SessionBinding {
  kind: string;
  value: string;
}

export type CapabilityScope =
  | { mode: "all" }
  | { mode: "selected"; names: readonly string[] };

export interface CreateSessionInput {
  sessionId?: string;
  skills?: readonly string[];
  tools?: readonly string[];
  metadata?: Record<string, unknown>;
  /** Reserved ownership data. Generic metadata cannot set or replace it. */
  binding?: SessionBinding;
}

export interface SessionInfo {
  sessionId: string;
  created: boolean;
  metadata: Record<string, unknown>;
  skills: CapabilityScope;
  tools: CapabilityScope;
  activeRunIds: readonly string[];
}

export interface SessionAccessOptions {
  expectedBinding?: SessionBinding;
}

export interface LegacySessionBindingMigrationInput {
  /** Exact protected metadata marker used by a known pre-binding adapter version. */
  legacyMetadata: {
    key: string;
    value: string;
  };
  /** Trusted binding to persist after the embedding host authorizes this Session ID. */
  binding: SessionBinding;
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
  expectedBinding?: SessionBinding;
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
  skills?: SkillCatalog;
  onEvent?: AgentLoopEventHandler;
}

interface ActiveRun {
  controller: AbortController;
  expectedBinding?: SessionBinding;
  bindingValidated: boolean;
  runId?: string;
  status: "queued" | "running";
  terminal: boolean;
  settled: Promise<void>;
  resolveSettled: () => void;
  detachSignal?: () => void;
}

interface PendingSessionOperation {
  /** FIFO-bound recovery may wait behind a Turn that close must cancel first. */
  waitBeforeCancel: boolean;
  settled: Promise<void>;
  resolveSettled: () => void;
}

interface ClosingSession {
  expectedBinding?: SessionBinding;
  promise: Promise<boolean>;
}

interface ResolvedPromptSession {
  session: Session;
  preparedSkills?: PreparedSkillSelection;
}

const SESSION_SKILLS = "runtime.skills";
const SESSION_TOOLS = "runtime.tools";
const SESSION_BINDING = "runtime.binding";
const SESSION_OWNERSHIP_VERSION = 1;
const LEGACY_ACP_CWD_METADATA = "acp.cwd";
const LEGACY_SESSION_BINDING_METADATA = [LEGACY_ACP_CWD_METADATA] as const;
const RESERVED_SESSION_METADATA = [
  SESSION_SKILLS,
  SESSION_TOOLS,
  SESSION_BINDING,
  ...LEGACY_SESSION_BINDING_METADATA,
] as const;

/** Protocol-neutral lifecycle facade used by ACP, HTTP, CLI, and embedded hosts. */
export class AgentRuntime {
  private readonly dependencies: ResolvedAgentRuntimeDependencies;
  private readonly active = new Map<string, Set<ActiveRun>>();
  private readonly sessionOperations = new Map<string, Set<PendingSessionOperation>>();
  private readonly closingSessions = new Map<string, ClosingSession>();
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
      skills: isSkillCatalog(skillLoader) ? skillLoader : undefined,
      onEvent: dependencies.onEvent,
    };
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
    const closings = [...this.closingSessions.values()].map((entry) => entry.promise);
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
    this.assertAvailable();
    return {
      contentTypes: ["text"],
      streaming: this.dependencies.loop.supportsStreaming,
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
    this.assertSessionOwnershipSupported(request.binding);
    const sessionId = request.sessionId ?? randomUUID();
    assertValidSessionId(sessionId);
    const operation = this.beginSessionOperation(sessionId, request.binding);
    try {
      await this.validateSelection(request.tools, request.skills);
      const metadata = sessionMetadata(request);
      const session = await this.dependencies.sessionStore.create(
        sessionId,
        metadata,
        request.binding ? { ownership: storedSessionOwnership(request.binding) } : undefined,
      );
      assertExpectedBinding(
        session,
        request.binding,
        this.dependencies.sessionStore.supportsSessionOwnership === true,
      );
      return this.toSessionInfo(session, true);
    } finally {
      this.endSessionOperation(sessionId, operation);
    }
  }

  async resumeSession(
    sessionId: string,
    options: SessionAccessOptions = {},
  ): Promise<SessionInfo> {
    this.assertAvailable();
    assertValidSessionId(sessionId);
    const expectedBinding = snapshotSessionBinding(options.expectedBinding);
    this.assertSessionOwnershipSupported(expectedBinding);
    const operation = this.beginSessionOperation(sessionId, expectedBinding);
    try {
      const session = await this.requireSession(sessionId);
      assertExpectedBinding(
        session,
        expectedBinding,
        this.dependencies.sessionStore.supportsSessionOwnership === true,
      );
      return this.toSessionInfo(session, false);
    } finally {
      this.endSessionOperation(sessionId, operation);
    }
  }

  /**
   * Upgrade one host-authorized legacy ownership marker inside the Session FIFO.
   * The caller must authorize the Session ID from trusted provenance; persisted
   * metadata is only re-checked here and is never sufficient authorization.
   */
  async migrateLegacySessionBinding(
    sessionId: string,
    input: LegacySessionBindingMigrationInput,
  ): Promise<SessionInfo> {
    this.assertAvailable();
    assertValidSessionId(sessionId);
    const request = snapshotLegacySessionBindingMigrationInput(input);
    this.assertSessionOwnershipSupported(request.binding);
    // The FIFO migration may be queued behind an active Turn. Close must abort
    // that Turn before awaiting this operation, just as it does for recovery.
    const operation = this.beginSessionOperation(sessionId, request.binding, false);
    try {
      return await this.dependencies.loop.runSessionOperationDeferred(sessionId, async () => {
        const session = await this.requireSession(sessionId);
        if (Object.hasOwn(session.metadata, SESSION_BINDING)) {
          throw new InvalidSessionBindingError(sessionId);
        }
        const existing = readStoredSessionOwnership(
          session,
          this.dependencies.sessionStore.supportsSessionOwnership === true,
        );
        if (existing) {
          // Concurrent trusted migrations may join after the first save. Do not
          // save again; in particular, never retry an outcome-unknown write.
          if (sameBinding(existing, request.binding)
            && !Object.hasOwn(session.metadata, request.legacyMetadata.key)) {
            return this.toSessionInfo(session, false);
          }
          throw new SessionBindingMismatchError(sessionId);
        }
        if (!Object.hasOwn(session.metadata, request.legacyMetadata.key)
          || session.metadata[request.legacyMetadata.key] !== request.legacyMetadata.value) {
          throw new SessionBindingMismatchError(sessionId);
        }

        const migrated: Session = {
          ...session,
          metadata: { ...session.metadata },
          ownership: storedSessionOwnership(request.binding),
        };
        delete migrated.metadata[request.legacyMetadata.key];
        // Exactly one versioned save. Outcome-unknown errors propagate so the
        // host reloads instead of guessing whether a retry is safe.
        await this.dependencies.sessionStore.save(migrated, { claimOwnership: true });
        return this.toSessionInfo(migrated, false);
      });
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

  async closeSession(
    sessionId: string,
    options: SessionAccessOptions = {},
  ): Promise<boolean> {
    this.assertAvailable();
    assertValidSessionId(sessionId);
    const expectedBinding = snapshotSessionBinding(options.expectedBinding);
    this.assertSessionOwnershipSupported(expectedBinding);
    const existing = this.closingSessions.get(sessionId);
    if (existing) {
      if (!sameBinding(existing.expectedBinding, expectedBinding)) {
        throw new SessionBindingMismatchError(sessionId);
      }
      return existing.promise;
    }

    let resolveClose!: (deleted: boolean) => void;
    let rejectClose!: (error: unknown) => void;
    const closing = new Promise<boolean>((resolve, reject) => {
      resolveClose = resolve;
      rejectClose = reject;
    });
    // Publish the gate before aborting. Abort listeners run synchronously and may
    // otherwise admit a re-entrant prompt while the session is being closed.
    const entry: ClosingSession = { expectedBinding, promise: closing };
    this.closingSessions.set(sessionId, entry);
    void this.finishCloseSession(sessionId, expectedBinding).then((deleted) => {
      if (this.closingSessions.get(sessionId) === entry) {
        this.closingSessions.delete(sessionId);
      }
      resolveClose(deleted);
    }, (error) => {
      if (this.closingSessions.get(sessionId) === entry) {
        this.closingSessions.delete(sessionId);
      }
      rejectClose(error);
    });
    return closing;
  }

  async prompt(input: PromptInput): Promise<TurnResult> {
    this.assertAvailable();
    const request = snapshotPromptInput(input);
    this.assertSessionOwnershipSupported(request.expectedBinding);
    assertValidSessionId(request.sessionId);
    this.assertSessionNotClosing(request.sessionId, request.expectedBinding);

    const controller = new AbortController();
    let resolveSettled!: () => void;
    const settled = new Promise<void>((resolve) => { resolveSettled = resolve; });
    const active: ActiveRun = {
      controller,
      expectedBinding: request.expectedBinding,
      bindingValidated: false,
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
      // Reserve the canonical per-Session FIFO slot before any asynchronous
      // Store or Skill work, so a slower first request cannot be overtaken by
      // a later request or lose the createIfMissing capability-scope race.
      const result = await this.dependencies.loop.runTurnDetailedDeferred(
        request.sessionId,
        async () => {
          throwIfAborted(controller.signal);
          const resolved = await this.resolvePromptSession(request, controller.signal);
          const session = resolved.session;
          assertExpectedBinding(
            session,
            request.expectedBinding,
            this.dependencies.sessionStore.supportsSessionOwnership === true,
          );
          active.bindingValidated = true;
          const sessionTools = readCapabilityScope(session, SESSION_TOOLS, "tool");
          const sessionSkills = readCapabilityScope(session, SESSION_SKILLS, "skill");
          const tools = selectWithinSession("tool", request.tools, sessionTools);
          const skills = selectWithinSession("skill", request.skills, sessionSkills);
          let preparedSkills = resolved.preparedSkills;
          if (preparedSkills && sameSelection(preparedSkills.names, skills)) {
            this.validateSelectionNames(tools, skills);
          } else {
            preparedSkills = await this.validateSelection(tools, skills, controller.signal);
          }

          return {
            input: {
              sessionId: request.sessionId,
              userInput: joinText(request.content),
              promptInjections: request.promptInjections,
              skills,
              tools,
              signal: controller.signal,
              onEvent: (event: AgentLoopEvent) => {
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
            },
            skills: preparedSkills,
          };
        },
      );
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

  cancel(
    sessionId: string,
    reason = "Cancelled by client",
    options: SessionAccessOptions = {},
  ): boolean {
    const expectedBinding = snapshotSessionBinding(options.expectedBinding);
    this.assertSessionOwnershipSupported(expectedBinding);
    const runs = this.active.get(sessionId);
    const cancellable = [...(runs ?? [])].filter(
      (run) => !run.terminal
        && !run.controller.signal.aborted
        && sameBinding(run.expectedBinding, expectedBinding),
    );
    if (cancellable.length === 0) return false;
    for (const run of cancellable) {
      run.controller.abort(new DOMException(reason, "AbortError"));
    }
    // A foreign request can exist briefly while its Store read is pending.
    // Cancelling that unvalidated request must not clear steering owned by a
    // different, already-authorized Turn on the same Session ID.
    if (cancellable.some((run) => run.bindingValidated)) {
      this.dependencies.loop.clearSteering(sessionId);
    }
    return true;
  }

  steer(
    sessionId: string,
    message: string,
    options: SessionAccessOptions = {},
  ): boolean {
    const expectedBinding = snapshotSessionBinding(options.expectedBinding);
    this.assertSessionOwnershipSupported(expectedBinding);
    const runs = this.active.get(sessionId);
    if (![...(runs ?? [])].some(
      (run) => !run.terminal
        && !run.controller.signal.aborted
        && run.bindingValidated
        && sameBinding(run.expectedBinding, expectedBinding),
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

  async recoverSession(
    sessionId: string,
    options: SessionAccessOptions = {},
  ): Promise<RecoveryResult> {
    this.assertAvailable();
    assertValidSessionId(sessionId);
    const expectedBinding = snapshotSessionBinding(options.expectedBinding);
    this.assertSessionOwnershipSupported(expectedBinding);
    const operation = this.beginSessionOperation(sessionId, expectedBinding, false);
    try {
      return await this.dependencies.loop.recoverSessionDeferred(sessionId, async () => {
        const session = await this.requireSession(sessionId);
        assertExpectedBinding(
          session,
          expectedBinding,
          this.dependencies.sessionStore.supportsSessionOwnership === true,
        );
      });
    } finally {
      this.endSessionOperation(sessionId, operation);
    }
  }

  private assertAvailable(): void {
    if (this.closed) throw new RuntimeClosedError();
  }

  private assertSessionOwnershipSupported(binding: SessionBinding | undefined): void {
    if (binding && this.dependencies.sessionStore.supportsSessionOwnership !== true) {
      throw new SessionOwnershipUnsupportedError();
    }
  }

  private assertSessionNotClosing(
    sessionId: string,
    expectedBinding?: SessionBinding,
  ): void {
    const closing = this.closingSessions.get(sessionId);
    if (!closing) return;
    if (!sameBinding(closing.expectedBinding, expectedBinding)) {
      throw new SessionBindingMismatchError(sessionId);
    }
    throw new SessionClosingError(sessionId);
  }

  private async finishCloseSession(
    sessionId: string,
    expectedBinding?: SessionBinding,
  ): Promise<boolean> {
    const operations = [...(this.sessionOperations.get(sessionId) ?? [])];
    await Promise.allSettled(
      operations.filter((operation) => operation.waitBeforeCancel)
        .map((operation) => operation.settled),
    );

    // Authorization happens after the closing gate is visible and independent
    // lifecycle reads/creates have settled. FIFO recovery is deliberately not
    // awaited here: it may be queued behind the Turn that close must cancel.
    // A mismatched close must never cancel an authorized active Turn.
    let session = await this.dependencies.sessionStore.get(sessionId);
    if (session) {
      assertExpectedBinding(
        session,
        expectedBinding,
        this.dependencies.sessionStore.supportsSessionOwnership === true,
      );
    }

    const pending = [...(this.active.get(sessionId) ?? [])];
    this.cancel(sessionId, "Session closed", { expectedBinding });
    await Promise.allSettled(pending.map((run) => run.settled));
    await Promise.allSettled(operations.map((operation) => operation.settled));

    // Re-read after active work settles so a binding changed by admitted work,
    // or a Session created by an already-admitted createIfMissing prompt, cannot
    // cross the ownership check immediately preceding deletion.
    session = await this.dependencies.sessionStore.get(sessionId);
    if (!session) return false;
    assertExpectedBinding(
      session,
      expectedBinding,
      this.dependencies.sessionStore.supportsSessionOwnership === true,
    );
    return this.dependencies.sessionStore.delete(sessionId);
  }

  private beginSessionOperation(
    sessionId: string,
    expectedBinding?: SessionBinding,
    waitBeforeCancel = true,
  ): PendingSessionOperation {
    this.assertSessionNotClosing(sessionId, expectedBinding);
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => { settle = resolve; });
    const operation: PendingSessionOperation = {
      waitBeforeCancel,
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

  private async resolvePromptSession(
    input: PromptInput,
    signal: AbortSignal,
  ): Promise<ResolvedPromptSession> {
    throwIfAborted(signal);
    const existing = await this.dependencies.sessionStore.get(input.sessionId);
    // Do not turn a cancellation that raced the read into an empty Session.
    throwIfAborted(signal);
    if (existing) return { session: existing };
    if (!input.createIfMissing) throw new SessionNotFoundError(input.sessionId);

    const preparedSkills = await this.validateSelection(input.tools, input.skills, signal);
    throwIfAborted(signal);
    try {
      return {
        session: await this.dependencies.sessionStore.create(
          input.sessionId,
          sessionMetadata({
            metadata: input.metadata,
            tools: input.tools,
            skills: input.skills,
            // For atomic createIfMissing admission, the expected owner becomes
            // the protected owner of the newly-created Session.
            binding: input.expectedBinding,
          }),
          input.expectedBinding
            ? { ownership: storedSessionOwnership(input.expectedBinding) }
            : undefined,
        ),
        preparedSkills,
      };
    } catch (error) {
      // Two adapters may admit the first turn concurrently. Whichever loses the
      // create race joins the same runtime-serialized session.
      if (!(error instanceof SessionAlreadyExistsError)) throw error;
      return {
        session: await this.requireSession(input.sessionId, signal),
        preparedSkills,
      };
    }
  }

  private async requireSession(sessionId: string, signal?: AbortSignal): Promise<Session> {
    throwIfAborted(signal);
    const session = await this.dependencies.sessionStore.get(sessionId);
    throwIfAborted(signal);
    if (!session) throw new SessionNotFoundError(sessionId);
    return session;
  }

  private async validateSelection(
    tools?: readonly string[],
    skills?: readonly string[],
    signal?: AbortSignal,
  ): Promise<PreparedSkillSelection> {
    this.validateSelectionNames(tools, skills);
    try {
      return await this.dependencies.loop.prepareSkillSelection(skills, signal);
    } catch (error) {
      // AbortSignal reasons are not limited to DOM AbortError (for example,
      // AbortSignal.timeout() uses TimeoutError and callers may supply their
      // own Error). Preserve the canonical cancellation reason exactly.
      throwIfAborted(signal);
      if (isAbortError(error)) throw error;
      throw new InvalidCapabilitySelectionError("skill", undefined, { cause: error });
    }
  }

  private validateSelectionNames(
    tools?: readonly string[],
    skills?: readonly string[],
  ): void {
    assertUniqueSelection("tool", tools);
    assertUniqueSelection("skill", skills);
    for (const name of tools ?? []) {
      try {
        this.dependencies.tools.get(name);
      } catch (error) {
        throw new InvalidCapabilitySelectionError("tool", name, { cause: error });
      }
    }
  }

  private toSessionInfo(session: Session, created: boolean): SessionInfo {
    // Validate protected metadata before projecting any part of the record.
    readSessionBinding(
      session,
      this.dependencies.sessionStore.supportsSessionOwnership === true,
    );
    const skills = cloneCapabilityScope(readCapabilityScope(session, SESSION_SKILLS, "skill"));
    const tools = cloneCapabilityScope(readCapabilityScope(session, SESSION_TOOLS, "tool"));
    const metadata = structuredClone(session.metadata);
    for (const key of RESERVED_SESSION_METADATA) delete metadata[key];
    return {
      sessionId: session.id,
      created,
      metadata,
      skills,
      tools,
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

export class SessionBindingMismatchError extends Error {
  constructor(sessionId: string, message = `Session binding does not match: ${sessionId}`) {
    super(message);
    this.name = "SessionBindingMismatchError";
  }
}

export class SessionOwnershipUnsupportedError extends Error {
  constructor() {
    super("SessionStore does not support protected Session ownership");
    this.name = "SessionOwnershipUnsupportedError";
  }
}

export class InvalidSessionBindingError extends SessionBindingMismatchError {
  constructor(sessionId: string) {
    super(sessionId, `Session has invalid persisted ownership: ${sessionId}`);
    this.name = "InvalidSessionBindingError";
  }
}

export class LegacySessionBindingMigrationRequiredError extends SessionBindingMismatchError {
  constructor(sessionId: string) {
    super(sessionId, `Session requires trusted legacy binding migration: ${sessionId}`);
    this.name = "LegacySessionBindingMigrationRequiredError";
  }
}

export class InvalidSessionCapabilityScopeError extends Error {
  constructor(sessionId: string, kind: "tool" | "skill") {
    super(`Session has invalid persisted ${kind} capability scope: ${sessionId}`);
    this.name = "InvalidSessionCapabilityScopeError";
  }
}

export class InvalidCapabilitySelectionError extends Error {
  constructor(
    readonly kind: "tool" | "skill",
    readonly capability?: string,
    options?: ErrorOptions,
    message?: string,
  ) {
    super(
      message ?? (capability
        ? `Unknown ${kind} capability: ${capability}`
        : `Invalid ${kind} capability selection`),
      options,
    );
    this.name = "InvalidCapabilitySelectionError";
  }
}

export class SessionCapabilityDeniedError extends Error {
  constructor(readonly kind: "tool" | "skill", readonly capability: string) {
    super(`Requested ${kind} is not allowed by the session: ${capability}`);
    this.name = "SessionCapabilityDeniedError";
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

function selectWithinSession(
  kind: "tool" | "skill",
  requested?: readonly string[],
  allowed: CapabilityScope = { mode: "all" },
): readonly string[] | undefined {
  if (!requested) return allowed.mode === "all" ? undefined : allowed.names;
  if (allowed.mode === "all") return requested;
  const allowedSet = new Set(allowed.names);
  const denied = requested.find((name) => !allowedSet.has(name));
  if (denied) throw new SessionCapabilityDeniedError(kind, denied);
  return requested;
}

function sessionMetadata(
  input: Pick<CreateSessionInput, "metadata" | "skills" | "tools" | "binding">,
): Record<string, unknown> {
  const metadata = structuredClone(input.metadata ?? {});
  for (const key of RESERVED_SESSION_METADATA) delete metadata[key];
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
    binding: snapshotSessionBinding(input.binding),
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
    expectedBinding: snapshotSessionBinding(input.expectedBinding),
    signal: input.signal,
    onEvent: input.onEvent,
  };
}

function snapshotSessionBinding(binding: SessionBinding | undefined): SessionBinding | undefined {
  if (!binding) return undefined;
  try {
    const ownership = snapshotSessionOwnership({
      version: SESSION_OWNERSHIP_VERSION,
      kind: binding.kind,
      value: binding.value,
    });
    if (ownership) return { kind: ownership.kind, value: ownership.value };
  } catch {
    throw new TypeError(
      "Session binding kind and value must be non-empty, NUL-free, well-formed Unicode strings",
    );
  }
  throw new TypeError(
    "Session binding kind and value must be non-empty, NUL-free, well-formed Unicode strings",
  );
}

function snapshotLegacySessionBindingMigrationInput(
  input: LegacySessionBindingMigrationInput,
): LegacySessionBindingMigrationInput {
  const key = input?.legacyMetadata?.key;
  const value = input?.legacyMetadata?.value;
  if (!LEGACY_SESSION_BINDING_METADATA.some((candidate) => candidate === key)) {
    throw new TypeError("Unsupported legacy Session binding metadata key");
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("Legacy Session binding metadata value must be a non-empty string");
  }
  const binding = snapshotSessionBinding(input.binding);
  if (!binding) throw new TypeError("Session binding is required");
  return { legacyMetadata: { key, value }, binding };
}

function readSessionBinding(
  session: Session,
  supportsSessionOwnership: boolean,
): SessionBinding | undefined {
  // This key was previously written through generic metadata and therefore has
  // no durable provenance. Its presence quarantines the record regardless of
  // shape, including the exact shape of a current ownership envelope.
  if (Object.hasOwn(session.metadata, SESSION_BINDING)) {
    throw new InvalidSessionBindingError(session.id);
  }
  const hasLegacyMarker = LEGACY_SESSION_BINDING_METADATA.some(
    (key) => Object.hasOwn(session.metadata, key),
  );
  const binding = readStoredSessionOwnership(session, supportsSessionOwnership);
  // Current writers and the trusted migrator make these representations
  // mutually exclusive. Their coexistence therefore has no trusted provenance.
  if (binding && hasLegacyMarker) throw new InvalidSessionBindingError(session.id);
  if (binding) return binding;
  if (hasLegacyMarker) {
    throw new LegacySessionBindingMigrationRequiredError(session.id);
  }
  return undefined;
}

function readStoredSessionOwnership(
  session: Session,
  supportsSessionOwnership: boolean,
): SessionBinding | undefined {
  if (!Object.hasOwn(session, "ownership")) return undefined;
  if (!supportsSessionOwnership) throw new InvalidSessionBindingError(session.id);
  try {
    const ownership = snapshotSessionOwnership(session.ownership);
    if (ownership) return { kind: ownership.kind, value: ownership.value };
  } catch {
    throw new InvalidSessionBindingError(session.id);
  }
  throw new InvalidSessionBindingError(session.id);
}

function storedSessionOwnership(binding: SessionBinding): SessionOwnership {
  return {
    version: SESSION_OWNERSHIP_VERSION,
    kind: binding.kind,
    value: binding.value,
  };
}

function assertExpectedBinding(
  session: Session,
  expected: SessionBinding | undefined,
  supportsSessionOwnership: boolean,
): void {
  const actual = readSessionBinding(session, supportsSessionOwnership);
  if (!sameBinding(actual, expected)) {
    throw new SessionBindingMismatchError(session.id);
  }
}

function sameBinding(
  left: SessionBinding | undefined,
  right: SessionBinding | undefined,
): boolean {
  return left === undefined
    ? right === undefined
    : right !== undefined && left.kind === right.kind && left.value === right.value;
}

function readCapabilityScope(
  session: Session,
  key: typeof SESSION_TOOLS | typeof SESSION_SKILLS,
  kind: "tool" | "skill",
): CapabilityScope {
  if (!Object.hasOwn(session.metadata, key)) return { mode: "all" };
  const value = session.metadata[key];
  if (!Array.isArray(value)
    || !value.every((item) => typeof item === "string")
    || new Set(value).size !== value.length) {
    throw new InvalidSessionCapabilityScopeError(session.id, kind);
  }
  return { mode: "selected", names: value };
}

function cloneCapabilityScope(scope: CapabilityScope): CapabilityScope {
  return scope.mode === "all"
    ? { mode: "all" }
    : { mode: "selected", names: [...scope.names] };
}

function assertUniqueSelection(
  kind: "tool" | "skill",
  names: readonly string[] | undefined,
): void {
  const seen = new Set<string>();
  for (const name of names ?? []) {
    if (seen.has(name)) {
      throw new InvalidCapabilitySelectionError(kind, name, {
        cause: new Error(`Duplicate ${kind} capability: ${name}`),
      }, `Duplicate ${kind} capability: ${name}`);
    }
    seen.add(name);
  }
}

function sameSelection(
  left: readonly string[],
  right: readonly string[] | undefined,
): boolean {
  const normalized = right ?? [];
  return left.length === normalized.length
    && left.every((name, index) => name === normalized[index]);
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

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
