import { randomUUID } from "node:crypto";
import type { AgentLoop, RecoveryResult } from "./agent-loop.js";
import type { AgentLoopEvent, AgentLoopEventHandler } from "./runtime/events.js";
import type { Session, SessionStore } from "./session.js";
import type { SkillCatalog, SkillDescriptor } from "./skills.js";
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
  sessionStore: SessionStore;
  tools: ToolRegistry;
  skills?: SkillCatalog;
  onEvent?: AgentLoopEventHandler;
}

interface ActiveRun {
  controller: AbortController;
  runId?: string;
  status: "queued" | "running";
  settled: Promise<void>;
  resolveSettled: () => void;
  detachSignal?: () => void;
}

const SESSION_SKILLS = "runtime.skills";
const SESSION_TOOLS = "runtime.tools";

/** Protocol-neutral lifecycle facade used by ACP, HTTP, CLI, and embedded hosts. */
export class AgentRuntime {
  private readonly active = new Map<string, Set<ActiveRun>>();
  private started = false;
  private closed = false;

  constructor(private readonly dependencies: AgentRuntimeDependencies) {}

  async start(): Promise<void> {
    if (this.closed) throw new RuntimeClosedError();
    this.started = true;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const pending = [...this.active.values()].flatMap((runs) => [...runs]);
    for (const runs of this.active.values()) {
      for (const run of runs) run.controller.abort(new DOMException("Runtime closed", "AbortError"));
    }
    await Promise.allSettled(pending.map((run) => run.settled));
  }

  async capabilities(): Promise<RuntimeCapabilities> {
    return {
      contentTypes: ["text"],
      streaming: true,
      cancellation: true,
      steering: true,
      sessionResume: true,
      tools: this.dependencies.tools.descriptors(),
      skills: await this.dependencies.skills?.list() ?? [],
    };
  }

  async createSession(input: CreateSessionInput = {}): Promise<SessionInfo> {
    this.assertAvailable();
    const sessionId = input.sessionId ?? randomUUID();
    await this.validateSelection(input.tools, input.skills);
    const metadata = {
      ...(input.metadata ?? {}),
      ...(input.tools ? { [SESSION_TOOLS]: [...input.tools] } : {}),
      ...(input.skills ? { [SESSION_SKILLS]: [...input.skills] } : {}),
    };
    const session = await this.dependencies.sessionStore.create(sessionId, metadata);
    return this.toSessionInfo(session, true);
  }

  async resumeSession(sessionId: string): Promise<SessionInfo> {
    this.assertAvailable();
    const session = await this.requireSession(sessionId);
    return this.toSessionInfo(session, false);
  }

  async getSession(sessionId: string): Promise<SessionInfo | undefined> {
    this.assertAvailable();
    const session = await this.dependencies.sessionStore.get(sessionId);
    return session ? this.toSessionInfo(session, false) : undefined;
  }

  async closeSession(sessionId: string): Promise<boolean> {
    this.assertAvailable();
    const pending = [...(this.active.get(sessionId) ?? [])];
    this.cancel(sessionId, "Session closed");
    await Promise.allSettled(pending.map((run) => run.settled));
    return this.dependencies.sessionStore.delete(sessionId);
  }

  async prompt(input: PromptInput): Promise<TurnResult> {
    this.assertAvailable();
    const session = await this.requireSession(input.sessionId);
    const sessionTools = readStringList(session.metadata[SESSION_TOOLS]);
    const sessionSkills = readStringList(session.metadata[SESSION_SKILLS]);
    const tools = selectWithinSession("tool", input.tools, sessionTools);
    const skills = selectWithinSession("skill", input.skills, sessionSkills);
    await this.validateSelection(tools, skills);

    const controller = new AbortController();
    let resolveSettled!: () => void;
    const settled = new Promise<void>((resolve) => { resolveSettled = resolve; });
    const active: ActiveRun = { controller, status: "queued", settled, resolveSettled };
    if (input.signal) {
      const abort = () => controller.abort(input.signal?.reason);
      if (input.signal.aborted) abort();
      else input.signal.addEventListener("abort", abort, { once: true });
      active.detachSignal = () => input.signal?.removeEventListener("abort", abort);
    }
    const runs = this.active.get(input.sessionId) ?? new Set<ActiveRun>();
    runs.add(active);
    this.active.set(input.sessionId, runs);

    try {
      const result = await this.dependencies.loop.runTurnDetailed({
        sessionId: input.sessionId,
        userInput: joinText(input.content),
        promptInjections: input.promptInjections,
        skills,
        tools,
        signal: controller.signal,
        onEvent: async (event) => {
          if (event.type === "run_started") {
            active.runId = event.runId;
            active.status = "running";
          }
          await this.dependencies.onEvent?.(event);
          await input.onEvent?.(event);
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
      if (runs.size === 0) this.active.delete(input.sessionId);
      active.resolveSettled();
    }
  }

  cancel(sessionId: string, reason = "Cancelled by client"): boolean {
    const runs = this.active.get(sessionId);
    if (!runs?.size) return false;
    for (const run of runs) {
      run.controller.abort(new DOMException(reason, "AbortError"));
    }
    return true;
  }

  steer(sessionId: string, message: string): boolean {
    if (!this.active.get(sessionId)?.size) return false;
    this.dependencies.loop.steer(sessionId, message);
    return true;
  }

  activeRuns(sessionId: string): readonly ActiveRunInfo[] {
    return [...(this.active.get(sessionId) ?? [])].map((run) => ({
      sessionId,
      runId: run.runId,
      status: run.status,
    }));
  }

  recoverSession(sessionId: string): Promise<RecoveryResult> {
    this.assertAvailable();
    return this.dependencies.loop.recoverSession(sessionId);
  }

  private assertAvailable(): void {
    if (this.closed) throw new RuntimeClosedError();
    if (!this.started) this.started = true;
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
    for (const name of tools ?? []) this.dependencies.tools.get(name);
    if (skills?.length) {
      if (!this.dependencies.skills) throw new Error("No SkillCatalog configured");
      await this.dependencies.skills.load(skills);
    }
  }

  private toSessionInfo(session: Session, created: boolean): SessionInfo {
    return {
      sessionId: session.id,
      created,
      metadata: session.metadata,
      skills: readStringList(session.metadata[SESSION_SKILLS]) ?? [],
      tools: readStringList(session.metadata[SESSION_TOOLS]) ?? [],
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
