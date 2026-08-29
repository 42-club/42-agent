import assert from "node:assert/strict";
import test from "node:test";
import {
  AgentLoop,
  AgentRuntime,
  InMemorySessionStore,
  SessionSaveOutcomeUnknownError,
  ToolRegistry,
  type LoadedSkill,
  type ModelClient,
  type SkillCatalog,
  type Session,
  type SessionCreateOptions,
  type SaveSessionOptions,
  type SessionStore,
  type Tool,
} from "../src/index.js";
import { ConversationCompressionTool } from "../src/tools/index.js";

class TestSkillCatalog implements SkillCatalog {
  loadCalls = 0;

  private readonly skills = new Map<string, LoadedSkill>([
    ["review", {
      name: "review",
      description: "Review instructions",
      instructions: "Review carefully.",
      path: "memory:review",
    }],
  ]);

  async list() {
    return [...this.skills.values()].map(({ name, description }) => ({ name, description }));
  }

  async load(names: readonly string[]) {
    this.loadCalls += 1;
    return names.map((name) => {
      const skill = this.skills.get(name);
      if (!skill) throw new Error(`Unknown skill: ${name}`);
      return skill;
    });
  }
}

function createRuntime(model: ModelClient) {
  const sessionStore = new InMemorySessionStore();
  const tools = new ToolRegistry();
  const echo: Tool = {
    name: "echo",
    description: "Echo input",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async execute() { return "echo"; },
  };
  tools.register(echo);
  tools.register(new ConversationCompressionTool(model));
  const skills = new TestSkillCatalog();
  const loop = new AgentLoop({
    model,
    sessionStore,
    tools,
    skillLoader: skills,
    requestApproval: async () => false,
  });
  return {
    runtime: new AgentRuntime({ loop, sessionStore, tools, skills }),
    sessionStore,
    skills,
  };
}

class OutcomeUnknownMigrationStore implements SessionStore {
  readonly supportsSessionOwnership = true as const;
  readonly error = new SessionSaveOutcomeUnknownError("migration save outcome is unknown");
  saveCalls = 0;
  private readonly base = new InMemorySessionStore();

  get(sessionId: string) { return this.base.get(sessionId); }
  create(
    sessionId: string,
    metadata?: Record<string, unknown>,
    options?: SessionCreateOptions,
  ) {
    return this.base.create(sessionId, metadata, options);
  }
  getOrCreate(sessionId: string) { return this.base.getOrCreate(sessionId); }
  delete(sessionId: string) { return this.base.delete(sessionId); }

  async save(session: Session, options?: SaveSessionOptions): Promise<void> {
    this.saveCalls += 1;
    await this.base.save(session, options);
    throw this.error;
  }
}

test("AgentRuntime exposes protocol-neutral lifecycle and scoped capabilities", async () => {
  let receivedTools: readonly string[] = [];
  let systemPrompt = "";
  const model: ModelClient = {
    async complete(request) {
      receivedTools = request.tools.map((tool) => tool.name);
      systemPrompt = request.systemPrompt;
      return { content: "done" };
    },
  };
  const { runtime } = createRuntime(model);
  const capabilities = await runtime.capabilities();
  assert.deepEqual(capabilities.contentTypes, ["text"]);
  assert.equal(capabilities.streaming, false);
  assert.deepEqual(capabilities.skills.map((skill) => skill.name), ["review"]);
  assert.deepEqual(capabilities.tools.map((tool) => tool.name), ["echo", "compress_conversation"]);

  const created = await runtime.createSession({
    sessionId: "runtime-session",
    tools: ["echo"],
    skills: ["review"],
    metadata: { owner: "host-application" },
  });
  assert.equal(created.created, true);
  assert.deepEqual(created.tools, { mode: "selected", names: ["echo"] });
  assert.deepEqual(created.skills, { mode: "selected", names: ["review"] });

  const result = await runtime.prompt({
    sessionId: created.sessionId,
    content: [{ type: "text", text: "hello" }],
  });
  assert.equal(result.stopReason, "end_turn");
  assert.deepEqual(result.content, [{ type: "text", text: "done" }]);
  assert.deepEqual(receivedTools, ["echo"]);
  assert.match(systemPrompt, /Review carefully/);

  const resumed = await runtime.resumeSession(created.sessionId);
  assert.equal(resumed.created, false);
  assert.equal(resumed.metadata.owner, "host-application");
  assert.equal(await runtime.closeSession(created.sessionId), true);
  assert.equal(await runtime.getSession(created.sessionId), undefined);
});

test("AgentRuntime reports streaming only when the canonical model supports it", async () => {
  const model: ModelClient = {
    async complete() {
      return { content: "unused" };
    },
    async *stream() {
      yield { type: "done" } as const;
    },
  };

  assert.equal((await createRuntime(model).runtime.capabilities()).streaming, true);
});

test("AgentRuntime resolves one Skill snapshot for an atomic create-and-prompt", async () => {
  const model: ModelClient = {
    async complete({ systemPrompt }) {
      assert.match(systemPrompt, /Review carefully/);
      return { content: "done" };
    },
  };
  const { runtime, skills } = createRuntime(model);

  const result = await runtime.prompt({
    sessionId: "skill-snapshot",
    content: [{ type: "text", text: "review" }],
    createIfMissing: true,
    skills: ["review"],
  });

  assert.equal(result.stopReason, "end_turn");
  assert.equal(skills.loadCalls, 1);
});

test("Skill resolution preserves a custom AbortSignal reason", async () => {
  let markLoading!: () => void;
  const loading = new Promise<void>((resolve) => { markLoading = resolve; });
  let releaseLoad!: () => void;
  const release = new Promise<void>((resolve) => { releaseLoad = resolve; });
  const skills: SkillCatalog = {
    async list() {
      return [{ name: "slow", description: "Slow Skill" }];
    },
    async load() {
      markLoading();
      await release;
      return [{
        name: "slow",
        description: "Slow Skill",
        instructions: "Wait carefully.",
        path: "memory:slow",
      }];
    },
  };
  const sessionStore = new InMemorySessionStore();
  const loop = new AgentLoop({
    model: { async complete() { return { content: "unused" }; } },
    sessionStore,
    tools: new ToolRegistry(),
    skillLoader: skills,
    requestApproval: async () => false,
  });
  const runtime = new AgentRuntime({ loop });
  const controller = new AbortController();
  const reason = new Error("custom cancellation");
  const pending = runtime.prompt({
    sessionId: "cancel-skill-resolution",
    content: [{ type: "text", text: "go" }],
    createIfMissing: true,
    skills: ["slow"],
    signal: controller.signal,
  });

  await loading;
  controller.abort(reason);
  releaseLoad();
  await assert.rejects(pending, (error) => error === reason);
  assert.equal(await sessionStore.get("cancel-skill-resolution"), undefined);
});

test("Runtime reserves FIFO order before asynchronous Skill and Session admission", async () => {
  let markFirstLoad!: () => void;
  const firstLoad = new Promise<void>((resolve) => { markFirstLoad = resolve; });
  let releaseFirstLoad!: () => void;
  const release = new Promise<void>((resolve) => { releaseFirstLoad = resolve; });
  let loads = 0;
  const skills: SkillCatalog = {
    async list() {
      return [{ name: "slow", description: "Slow Skill" }];
    },
    async load(names) {
      loads += 1;
      if (loads === 1) {
        markFirstLoad();
        await release;
      }
      return names.map((name) => ({
        name,
        description: "Slow Skill",
        instructions: "First request instructions.",
        path: `memory:${name}`,
      }));
    },
  };
  const observed: string[] = [];
  const sessionStore = new InMemorySessionStore();
  const loop = new AgentLoop({
    model: {
      async complete({ messages }) {
        observed.push(messages.at(-1)?.content ?? "");
        return { content: "done" };
      },
    },
    sessionStore,
    tools: new ToolRegistry(),
    skillLoader: skills,
    requestApproval: async () => false,
  });
  const runtime = new AgentRuntime({ loop });

  const first = runtime.prompt({
    sessionId: "preflight-fifo",
    content: [{ type: "text", text: "first" }],
    createIfMissing: true,
    skills: ["slow"],
  });
  await firstLoad;
  const second = runtime.prompt({
    sessionId: "preflight-fifo",
    content: [{ type: "text", text: "second" }],
    createIfMissing: true,
    skills: [],
  });
  await new Promise<void>((resolve) => { setImmediate(resolve); });
  assert.deepEqual(observed, []);
  assert.equal(await sessionStore.get("preflight-fifo"), undefined);

  releaseFirstLoad();
  await Promise.all([first, second]);
  assert.deepEqual(observed, ["first", "second"]);
  assert.deepEqual(
    (await runtime.getSession("preflight-fifo"))?.skills,
    { mode: "selected", names: ["slow"] },
  );
});

test("AgentRuntime is ready after construction and lifecycle queries reject after close", async () => {
  const model: ModelClient = {
    async complete() {
      return { content: "unused" };
    },
  };
  const { runtime } = createRuntime(model);

  assert.equal((await runtime.capabilities()).sessionResume, true);
  await runtime.close();
  await assert.rejects(runtime.capabilities(), { name: "RuntimeClosedError" });
  await assert.rejects(
    runtime.createSession({ sessionId: "after-close" }),
    { name: "RuntimeClosedError" },
  );
});

test("AgentRuntime cancels an active prompt by session ID", async () => {
  let modelStarted!: () => void;
  const started = new Promise<void>((resolve) => { modelStarted = resolve; });
  const model: ModelClient = {
    async complete(request) {
      modelStarted();
      return new Promise((_resolve, reject) => {
        request.signal?.addEventListener("abort", () => reject(request.signal?.reason), { once: true });
      });
    },
  };
  const { runtime, sessionStore } = createRuntime(model);
  await runtime.createSession({ sessionId: "cancel-runtime" });
  const running = runtime.prompt({
    sessionId: "cancel-runtime",
    content: [{ type: "text", text: "wait" }],
  });
  await started;
  assert.equal(runtime.activeRuns("cancel-runtime").length, 1);
  assert.equal(runtime.cancel("cancel-runtime"), true);
  assert.equal(runtime.steer("cancel-runtime", "must not leak into a future turn"), false);
  await assert.rejects(running, { name: "AbortError" });
  assert.equal((await sessionStore.get("cancel-runtime"))?.runState?.status, "cancelled");
  assert.deepEqual(runtime.activeRuns("cancel-runtime"), []);
});

test("cancellation wins when a model settles in the same task", async () => {
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  let resolveModel!: (value: { content: string }) => void;
  const model: ModelClient = {
    async complete() {
      markStarted();
      return new Promise((resolve) => { resolveModel = resolve; });
    },
  };
  const { runtime, sessionStore } = createRuntime(model);
  await runtime.createSession({ sessionId: "cancel-settle-race" });
  const running = runtime.prompt({
    sessionId: "cancel-settle-race",
    content: [{ type: "text", text: "go" }],
  });
  await started;

  resolveModel({ content: "must not commit" });
  assert.equal(runtime.cancel("cancel-settle-race"), true);
  await assert.rejects(running, { name: "AbortError" });
  const session = await sessionStore.get("cancel-settle-race");
  assert.equal(session?.runState?.status, "cancelled");
  assert.equal(session?.messages.some((message) => message.content === "must not commit"), false);
});

test("a prompt cancelled before FIFO admission does not mutate Session history", async () => {
  let modelCalls = 0;
  const model: ModelClient = {
    async complete() {
      modelCalls += 1;
      return { content: "unexpected" };
    },
  };
  const { runtime, sessionStore } = createRuntime(model);
  await runtime.createSession({ sessionId: "pre-aborted" });
  const controller = new AbortController();
  controller.abort(new DOMException("already cancelled", "AbortError"));

  await assert.rejects(runtime.prompt({
    sessionId: "pre-aborted",
    content: [{ type: "text", text: "must not append" }],
    signal: controller.signal,
  }), { name: "AbortError" });
  assert.equal(modelCalls, 0);
  const session = await sessionStore.get("pre-aborted");
  assert.deepEqual(session?.messages, []);
  assert.equal(session?.runState, undefined);
});

test("a queued prompt cancelled before its FIFO slot does not create a Run", async () => {
  let markFirstStarted!: () => void;
  const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
  let releaseFirst!: () => void;
  const release = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let modelCalls = 0;
  const model: ModelClient = {
    async complete() {
      modelCalls += 1;
      markFirstStarted();
      await release;
      return { content: "first done" };
    },
  };
  const { runtime, sessionStore } = createRuntime(model);
  await runtime.createSession({ sessionId: "queued-abort" });
  const first = runtime.prompt({
    sessionId: "queued-abort",
    content: [{ type: "text", text: "first" }],
  });
  await firstStarted;
  const controller = new AbortController();
  const queued = runtime.prompt({
    sessionId: "queued-abort",
    content: [{ type: "text", text: "must not append" }],
    signal: controller.signal,
  });
  controller.abort(new DOMException("cancel queued", "AbortError"));
  releaseFirst();

  assert.equal((await first).stopReason, "end_turn");
  await assert.rejects(queued, { name: "AbortError" });
  assert.equal(modelCalls, 1);
  const session = await sessionStore.get("queued-abort");
  assert.deepEqual(session?.messages.map((message) => message.content), ["first", "first done"]);
  assert.equal(session?.runState?.status, "completed");
});

test("concurrent Runtime close calls join the same in-flight shutdown", async () => {
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  let releaseModel!: () => void;
  const release = new Promise<void>((resolve) => { releaseModel = resolve; });
  let runtime!: AgentRuntime;
  let reentrantClose: Promise<void> | undefined;
  let markAborted!: () => void;
  const aborted = new Promise<void>((resolve) => { markAborted = resolve; });
  const model: ModelClient = {
    async complete(request) {
      markStarted();
      request.signal?.addEventListener("abort", () => {
        reentrantClose = runtime.close();
        markAborted();
      }, { once: true });
      // Deliberately ignore AbortSignal so close must join the admitted work.
      await release;
      return { content: "too late" };
    },
  };
  ({ runtime } = createRuntime(model));
  await runtime.createSession({ sessionId: "close-join" });
  const running = runtime.prompt({
    sessionId: "close-join",
    content: [{ type: "text", text: "wait" }],
  });
  await started;

  const firstClose = runtime.close();
  const secondClose = runtime.close();
  assert.equal(firstClose, secondClose);
  await aborted;
  assert.equal(reentrantClose, firstClose);
  let closeSettled = false;
  void secondClose.then(() => { closeSettled = true; });
  await new Promise<void>((resolve) => { setImmediate(resolve); });
  assert.equal(closeSettled, false);

  releaseModel();
  await assert.rejects(running, { name: "AbortError" });
  await Promise.all([firstClose, secondClose, reentrantClose]);
  assert.equal(closeSettled, true);
});

test("steering admission closes at the terminal barrier and cannot leak to the next Turn", async () => {
  let modelCalls = 0;
  const model: ModelClient = {
    async complete() {
      modelCalls += 1;
      return { content: `turn-${modelCalls}` };
    },
  };
  const { runtime, sessionStore } = createRuntime(model);
  await runtime.createSession({ sessionId: "terminal-steering" });
  let accepted: boolean | undefined;
  let cancelled: boolean | undefined;
  await runtime.prompt({
    sessionId: "terminal-steering",
    content: [{ type: "text", text: "first" }],
    onEvent(event) {
      if (event.type === "run_completed") {
        accepted = runtime.steer(event.sessionId, "must not cross Turns");
        cancelled = runtime.cancel(event.sessionId);
      }
    },
  });
  assert.equal(accepted, false);
  assert.equal(cancelled, false);

  await runtime.prompt({
    sessionId: "terminal-steering",
    content: [{ type: "text", text: "second" }],
  });
  assert.equal(modelCalls, 2);
  assert.equal(
    (await sessionStore.get("terminal-steering"))?.messages.some(
      (message) => message.metadata?.kind === "steering",
    ),
    false,
  );
});

test("Runtime closes terminal control before Loop-level observers run", async () => {
  const sessionStore = new InMemorySessionStore();
  const tools = new ToolRegistry();
  let runtime!: AgentRuntime;
  let cancelResult: boolean | undefined;
  const loop = new AgentLoop({
    model: { async complete() { return { content: "done" }; } },
    sessionStore,
    tools,
    requestApproval: async () => false,
    onEvent(event) {
      if (event.type === "run_completed") cancelResult = runtime.cancel(event.sessionId);
    },
  });
  runtime = new AgentRuntime({ loop });
  await runtime.createSession({ sessionId: "global-terminal-observer" });

  assert.equal((await runtime.prompt({
    sessionId: "global-terminal-observer",
    content: [{ type: "text", text: "go" }],
  })).stopReason, "end_turn");
  assert.equal(cancelResult, false);
  assert.equal((await sessionStore.get("global-terminal-observer"))?.runState?.status, "completed");
});

test("event observers cannot deadlock a run by closing the same session", async () => {
  const model: ModelClient = { async complete() { return { content: "unused" }; } };
  const sessionStore = new InMemorySessionStore();
  const tools = new ToolRegistry();
  const loop = new AgentLoop({
    model,
    sessionStore,
    tools,
    requestApproval: async () => false,
  });
  const runtime = new AgentRuntime({ loop });
  await runtime.createSession({ sessionId: "observer-close" });

  let closing: Promise<boolean> | undefined;
  const running = runtime.prompt({
    sessionId: "observer-close",
    content: [{ type: "text", text: "go" }],
    onEvent(event) {
      if (event.type === "run_started") closing = runtime.closeSession(event.sessionId);
    },
  });

  await assert.rejects(running, { name: "AbortError" });
  assert.equal(await closing, true);
  assert.equal(await runtime.getSession("observer-close"), undefined);
});

test("a hung event observer cannot keep canonical execution running", async () => {
  const model: ModelClient = { async complete() { return { content: "done" }; } };
  const { runtime, sessionStore } = createRuntime(model);
  await runtime.createSession({ sessionId: "hung-observer" });

  const never = new Promise<void>(() => undefined);
  const result = await runtime.prompt({
    sessionId: "hung-observer",
    content: [{ type: "text", text: "go" }],
    onEvent(event) {
      return event.type === "run_started" ? never : undefined;
    },
  });

  assert.equal(result.stopReason, "end_turn");
  assert.equal((await sessionStore.get("hung-observer"))?.runState?.status, "completed");
});

test("AgentRuntime prevents a turn from widening session capabilities", async () => {
  const { runtime } = createRuntime({ async complete() { return { content: "unused" }; } });
  await runtime.createSession({ sessionId: "scoped", tools: ["echo"] });
  await assert.rejects(
    runtime.prompt({
      sessionId: "scoped",
      content: [{ type: "text", text: "go" }],
      tools: ["compress_conversation"],
    }),
    /not allowed by the session/,
  );
});

test("Session capability scopes distinguish unrestricted from selected-empty", async () => {
  const { runtime } = createRuntime({ async complete() { return { content: "unused" }; } });

  const unrestricted = await runtime.createSession({ sessionId: "scope-all" });
  assert.deepEqual(unrestricted.tools, { mode: "all" });
  assert.deepEqual(unrestricted.skills, { mode: "all" });

  const empty = await runtime.createSession({
    sessionId: "scope-empty",
    tools: [],
    skills: [],
  });
  assert.deepEqual(empty.tools, { mode: "selected", names: [] });
  assert.deepEqual(empty.skills, { mode: "selected", names: [] });
});

test("malformed persisted capability scopes are rejected instead of widening access", async () => {
  let modelCalls = 0;
  const { runtime, sessionStore } = createRuntime({
    async complete() {
      modelCalls += 1;
      return { content: "must not run" };
    },
  });
  await sessionStore.create("malformed-tools", { "runtime.tools": { allow: "all" } });
  await sessionStore.create("malformed-skills", { "runtime.skills": ["review", 42] });

  await assert.rejects(
    runtime.prompt({
      sessionId: "malformed-tools",
      content: [{ type: "text", text: "go" }],
    }),
    { name: "InvalidSessionCapabilityScopeError" },
  );
  await assert.rejects(
    runtime.resumeSession("malformed-skills"),
    { name: "InvalidSessionCapabilityScopeError" },
  );
  assert.equal(modelCalls, 0);
});

test("reserved Session binding cannot be forged through generic metadata", async () => {
  const { runtime, sessionStore } = createRuntime({
    async complete() { return { content: "done" }; },
  });
  const binding = { kind: "test-adapter", value: "owner-a" };
  const created = await runtime.createSession({
    sessionId: "protected-binding",
    binding,
    metadata: {
      "runtime.binding": { version: 1, kind: "test-adapter", value: "forged-owner" },
      "acp.cwd": "/forged-workspace",
      visible: "kept",
    },
  });

  assert.equal(created.metadata["runtime.binding"], undefined);
  assert.equal(created.metadata["acp.cwd"], undefined);
  assert.equal(created.metadata.visible, "kept");
  assert.deepEqual(
    (await sessionStore.get("protected-binding"))?.ownership,
    { version: 1, ...binding },
  );
  assert.equal(
    (await sessionStore.get("protected-binding"))?.metadata["runtime.binding"],
    undefined,
  );
  assert.equal(
    (await sessionStore.get("protected-binding"))?.metadata["acp.cwd"],
    undefined,
  );

  const forgedOnly = await runtime.createSession({
    sessionId: "forged-binding-only",
    metadata: { "runtime.binding": { version: 1, ...binding } },
  });
  assert.equal(forgedOnly.metadata["runtime.binding"], undefined);
  assert.equal(
    (await sessionStore.get("forged-binding-only"))?.metadata["runtime.binding"],
    undefined,
  );
  await assert.rejects(
    runtime.resumeSession("forged-binding-only", { expectedBinding: binding }),
    { name: "SessionBindingMismatchError" },
  );
  await assert.rejects(
    runtime.createSession({
      sessionId: "invalid-binding-string",
      binding: { kind: "test\0adapter", value: "owner-a" },
    }),
    TypeError,
  );
  assert.equal(await sessionStore.get("invalid-binding-string"), undefined);
});

test("Runtime trusts top-level ownership only from a capable Store", async () => {
  const binding = { kind: "test-adapter", value: "owner-a" };
  const session: Session = {
    id: "uncapable-ownership",
    messages: [],
    metadata: {},
    ownership: { version: 1, ...binding },
  };
  let getCalls = 0;
  let createCalls = 0;
  const sessionStore: SessionStore = {
    async get() {
      getCalls += 1;
      return session;
    },
    async create() {
      createCalls += 1;
      return session;
    },
    async getOrCreate() { return session; },
    async save() {},
    async delete() { return false; },
  };
  const loop = new AgentLoop({
    model: { async complete() { return { content: "unused" }; } },
    sessionStore,
    tools: new ToolRegistry(),
    requestApproval: async () => false,
  });
  const runtime = new AgentRuntime({ loop });

  await assert.rejects(
    runtime.resumeSession(session.id, { expectedBinding: binding }),
    { name: "SessionOwnershipUnsupportedError" },
  );
  assert.equal(getCalls, 0);
  await assert.rejects(
    runtime.resumeSession(session.id),
    { name: "InvalidSessionBindingError" },
  );
  await assert.rejects(
    runtime.createSession({ sessionId: "uncapable-create", binding }),
    { name: "SessionOwnershipUnsupportedError" },
  );
  assert.equal(createCalls, 0);
});

test("legacy ACP ownership stays quarantined until an exact trusted FIFO migration", async () => {
  let modelCalls = 0;
  const { runtime, sessionStore } = createRuntime({
    async complete() {
      modelCalls += 1;
      return { content: "done" };
    },
  });
  const workspace = "/trusted/workspace";
  const binding = { kind: "acp.workspace", value: workspace };
  await sessionStore.create("legacy-acp-session", {
    "acp.cwd": workspace,
    visible: "preserved",
  });

  await assert.rejects(
    runtime.resumeSession("legacy-acp-session"),
    { name: "LegacySessionBindingMigrationRequiredError" },
  );
  await assert.rejects(
    runtime.resumeSession("legacy-acp-session", { expectedBinding: binding }),
    { name: "LegacySessionBindingMigrationRequiredError" },
  );
  await assert.rejects(
    runtime.prompt({
      sessionId: "legacy-acp-session",
      content: [{ type: "text", text: "must remain quarantined" }],
    }),
    { name: "LegacySessionBindingMigrationRequiredError" },
  );
  await assert.rejects(
    runtime.closeSession("legacy-acp-session"),
    { name: "LegacySessionBindingMigrationRequiredError" },
  );
  assert.equal(modelCalls, 0);
  assert.ok(await sessionStore.get("legacy-acp-session"));

  await assert.rejects(
    runtime.migrateLegacySessionBinding("legacy-acp-session", {
      legacyMetadata: { key: "acp.cwd", value: "/wrong/workspace" },
      binding,
    }),
    { name: "SessionBindingMismatchError" },
  );

  const migrate = () => runtime.migrateLegacySessionBinding("legacy-acp-session", {
    legacyMetadata: { key: "acp.cwd", value: workspace },
    binding,
  });
  const migrated = await Promise.all([migrate(), migrate()]);
  assert.deepEqual(migrated.map((info) => info.metadata.visible), ["preserved", "preserved"]);
  const stored = await sessionStore.get("legacy-acp-session");
  assert.equal(stored?.version, 1);
  assert.equal(stored?.metadata["acp.cwd"], undefined);
  assert.equal(stored?.metadata["runtime.binding"], undefined);
  assert.deepEqual(stored?.ownership, { version: 1, ...binding });

  await assert.rejects(
    runtime.resumeSession("legacy-acp-session"),
    { name: "SessionBindingMismatchError" },
  );
  assert.equal((await runtime.resumeSession("legacy-acp-session", {
    expectedBinding: binding,
  })).metadata.visible, "preserved");
  assert.equal((await runtime.prompt({
    sessionId: "legacy-acp-session",
    expectedBinding: binding,
    content: [{ type: "text", text: "now admitted" }],
  })).stopReason, "end_turn");
  assert.equal(modelCalls, 1);
});

test("bare pre-version binding metadata cannot be promoted as trusted ownership", async () => {
  const { runtime, sessionStore } = createRuntime({
    async complete() { return { content: "must not run" }; },
  });
  const workspace = "/trusted/workspace";
  const binding = { kind: "acp.workspace", value: workspace };
  await sessionStore.create("bare-binding", {
    "runtime.binding": binding,
    "acp.cwd": workspace,
  });

  await assert.rejects(
    runtime.resumeSession("bare-binding"),
    { name: "InvalidSessionBindingError" },
  );
  await assert.rejects(
    runtime.resumeSession("bare-binding", { expectedBinding: binding }),
    { name: "InvalidSessionBindingError" },
  );
  await assert.rejects(
    runtime.migrateLegacySessionBinding("bare-binding", {
      legacyMetadata: { key: "acp.cwd", value: workspace },
      binding,
    }),
    { name: "InvalidSessionBindingError" },
  );
  assert.deepEqual(
    (await sessionStore.get("bare-binding"))?.metadata["runtime.binding"],
    binding,
  );

  await sessionStore.create("mixed-binding-formats", {
    "runtime.binding": { version: 1, ...binding },
    "acp.cwd": workspace,
  });
  await assert.rejects(
    runtime.resumeSession("mixed-binding-formats", { expectedBinding: binding }),
    { name: "InvalidSessionBindingError" },
  );
  await assert.rejects(
    runtime.migrateLegacySessionBinding("mixed-binding-formats", {
      legacyMetadata: { key: "acp.cwd", value: workspace },
      binding,
    }),
    { name: "InvalidSessionBindingError" },
  );
});

test("legacy binding migration propagates an unknown save outcome without retrying", async () => {
  const sessionStore = new OutcomeUnknownMigrationStore();
  const loop = new AgentLoop({
    model: { async complete() { return { content: "unused" }; } },
    sessionStore,
    tools: new ToolRegistry(),
    requestApproval: async () => false,
  });
  const runtime = new AgentRuntime({ loop });
  const workspace = "/trusted/workspace";
  const binding = { kind: "acp.workspace", value: workspace };
  await sessionStore.create("unknown-migration", { "acp.cwd": workspace });

  await assert.rejects(
    runtime.migrateLegacySessionBinding("unknown-migration", {
      legacyMetadata: { key: "acp.cwd", value: workspace },
      binding,
    }),
    (error) => error === sessionStore.error,
  );
  assert.equal(sessionStore.saveCalls, 1);
  assert.deepEqual(
    (await sessionStore.get("unknown-migration"))?.ownership,
    { version: 1, ...binding },
  );
  assert.equal(
    (await sessionStore.get("unknown-migration"))?.metadata["runtime.binding"],
    undefined,
  );
  assert.equal((await runtime.resumeSession("unknown-migration", {
    expectedBinding: binding,
  })).created, false);
  assert.equal(sessionStore.saveCalls, 1);
});

test("expected Session binding gates prompt, resume, and close", async () => {
  let modelCalls = 0;
  const { runtime, sessionStore } = createRuntime({
    async complete() {
      modelCalls += 1;
      return { content: "done" };
    },
  });
  const binding = { kind: "test-adapter", value: "owner-a" };
  const foreign = { kind: "test-adapter", value: "owner-b" };
  await runtime.createSession({ sessionId: "binding-gate", binding });

  await assert.rejects(
    runtime.resumeSession("binding-gate"),
    { name: "SessionBindingMismatchError" },
  );
  await assert.rejects(
    runtime.recoverSession("binding-gate"),
    { name: "SessionBindingMismatchError" },
  );
  await assert.rejects(
    runtime.resumeSession("binding-gate", { expectedBinding: foreign }),
    { name: "SessionBindingMismatchError" },
  );
  await assert.rejects(
    runtime.prompt({
      sessionId: "binding-gate",
      content: [{ type: "text", text: "missing owner" }],
    }),
    { name: "SessionBindingMismatchError" },
  );
  await assert.rejects(
    runtime.prompt({
      sessionId: "binding-gate",
      expectedBinding: foreign,
      content: [{ type: "text", text: "must not append" }],
    }),
    { name: "SessionBindingMismatchError" },
  );
  assert.equal(modelCalls, 0);
  assert.deepEqual((await sessionStore.get("binding-gate"))?.messages, []);

  assert.equal((await runtime.resumeSession("binding-gate", {
    expectedBinding: binding,
  })).created, false);
  assert.deepEqual(
    await runtime.recoverSession("binding-gate", { expectedBinding: binding }),
    { recovered: false, interruptedToolCalls: 0 },
  );
  assert.equal((await runtime.prompt({
    sessionId: "binding-gate",
    expectedBinding: binding,
    content: [{ type: "text", text: "allowed" }],
  })).stopReason, "end_turn");
  assert.equal(modelCalls, 1);

  await assert.rejects(
    runtime.closeSession("binding-gate", { expectedBinding: foreign }),
    { name: "SessionBindingMismatchError" },
  );
  assert.ok(await sessionStore.get("binding-gate"));
  assert.equal(await runtime.closeSession("binding-gate", { expectedBinding: binding }), true);
  assert.equal(await runtime.closeSession("binding-gate", { expectedBinding: binding }), false);
});

test("missing or foreign binding cannot cancel or close an authorized active Turn", async () => {
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  let finishModel!: () => void;
  const finish = new Promise<void>((resolve) => { finishModel = resolve; });
  let aborted = false;
  const { runtime, sessionStore } = createRuntime({
    async complete(request) {
      markStarted();
      request.signal?.addEventListener("abort", () => { aborted = true; }, { once: true });
      await finish;
      return { content: "done" };
    },
  });
  const binding = { kind: "test-adapter", value: "owner-a" };
  const foreign = { kind: "test-adapter", value: "owner-b" };
  await runtime.createSession({ sessionId: "bound-active", binding });
  const running = runtime.prompt({
    sessionId: "bound-active",
    expectedBinding: binding,
    content: [{ type: "text", text: "wait" }],
  });
  await started;

  assert.equal(runtime.cancel("bound-active"), false);
  assert.equal(runtime.cancel("bound-active", "foreign", { expectedBinding: foreign }), false);
  assert.equal(runtime.steer("bound-active", "foreign steering"), false);
  await assert.rejects(
    runtime.closeSession("bound-active"),
    { name: "SessionBindingMismatchError" },
  );
  assert.equal(aborted, false);
  assert.equal(runtime.activeRuns("bound-active").length, 1);

  finishModel();
  assert.equal((await running).stopReason, "end_turn");
  assert.equal((await sessionStore.get("bound-active"))?.runState?.status, "completed");
  assert.equal(await runtime.closeSession("bound-active", { expectedBinding: binding }), true);
});

test("cancelling an unvalidated foreign prompt cannot clear authorized steering", async () => {
  let markModelStarted!: () => void;
  const modelStarted = new Promise<void>((resolve) => { markModelStarted = resolve; });
  let releaseModel!: () => void;
  const release = new Promise<void>((resolve) => { releaseModel = resolve; });
  let modelCalls = 0;
  const { runtime } = createRuntime({
    async complete({ messages }) {
      modelCalls += 1;
      if (modelCalls === 1) {
        markModelStarted();
        await release;
        return { content: "initial" };
      }
      assert.equal(messages.at(-1)?.content, "keep direction");
      return { content: "steered" };
    },
  });
  const binding = { kind: "test-adapter", value: "owner-a" };
  const foreignBinding = { kind: "test-adapter", value: "owner-b" };
  await runtime.createSession({ sessionId: "foreign-cancel-steering", binding });
  const authorized = runtime.prompt({
    sessionId: "foreign-cancel-steering",
    expectedBinding: binding,
    content: [{ type: "text", text: "start" }],
  });
  await modelStarted;
  assert.equal(runtime.steer(
    "foreign-cancel-steering",
    "keep direction",
    { expectedBinding: binding },
  ), true);

  const foreign = runtime.prompt({
    sessionId: "foreign-cancel-steering",
    expectedBinding: foreignBinding,
    content: [{ type: "text", text: "foreign" }],
  });
  assert.equal(runtime.cancel(
    "foreign-cancel-steering",
    "cancel foreign",
    { expectedBinding: foreignBinding },
  ), true);
  releaseModel();

  assert.equal((await authorized).content[0]?.text, "steered");
  await assert.rejects(foreign, { name: "AbortError" });
});

test("an in-flight Session close can only be joined by the same binding", async () => {
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  let releaseModel!: () => void;
  const release = new Promise<void>((resolve) => { releaseModel = resolve; });
  const { runtime } = createRuntime({
    async complete() {
      markStarted();
      await release;
      return { content: "too late" };
    },
  });
  const binding = { kind: "test-adapter", value: "owner-a" };
  await runtime.createSession({ sessionId: "binding-close-join", binding });
  const running = runtime.prompt({
    sessionId: "binding-close-join",
    expectedBinding: binding,
    content: [{ type: "text", text: "wait" }],
  });
  await started;

  const closing = runtime.closeSession("binding-close-join", { expectedBinding: binding });
  const joined = runtime.closeSession("binding-close-join", { expectedBinding: binding });
  await assert.rejects(
    runtime.closeSession("binding-close-join"),
    { name: "SessionBindingMismatchError" },
  );
  await assert.rejects(
    runtime.prompt({
      sessionId: "binding-close-join",
      content: [{ type: "text", text: "foreign during close" }],
    }),
    { name: "SessionBindingMismatchError" },
  );
  releaseModel();
  await assert.rejects(running, { name: "AbortError" });
  assert.deepEqual(await Promise.all([closing, joined]), [true, true]);
});

test("duplicate capability scopes are rejected before creating or mutating a session", async () => {
  const model: ModelClient = { async complete() { return { content: "unused" }; } };
  const { runtime, sessionStore } = createRuntime(model);

  await assert.rejects(
    runtime.createSession({ sessionId: "duplicate-create", tools: ["echo", "echo"] }),
    /Duplicate tool capability: echo/,
  );
  assert.equal(await sessionStore.get("duplicate-create"), undefined);

  await assert.rejects(
    runtime.prompt({
      sessionId: "duplicate-prompt",
      content: [{ type: "text", text: "go" }],
      createIfMissing: true,
      skills: ["review", "review"],
    }),
    /Duplicate skill capability: review/,
  );
  assert.equal(await sessionStore.get("duplicate-prompt"), undefined);
});

class DelayedReadSessionStore implements SessionStore {
  private readonly base = new InMemorySessionStore();
  getCalls = 0;
  createCalls = 0;
  private nextRead?: {
    entered: () => void;
    wait: Promise<void>;
  };

  delayNextGet(): { entered: Promise<void>; release: () => void } {
    let entered!: () => void;
    let release!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const wait = new Promise<void>((resolve) => { release = resolve; });
    this.nextRead = { entered, wait };
    return { entered: enteredPromise, release };
  }

  async get(sessionId: string): Promise<Session | undefined> {
    this.getCalls += 1;
    const session = await this.base.get(sessionId);
    const delayed = this.nextRead;
    if (delayed) {
      this.nextRead = undefined;
      delayed.entered();
      await delayed.wait;
    }
    return session;
  }

  create(sessionId: string, metadata?: Record<string, unknown>): Promise<Session> {
    this.createCalls += 1;
    return this.base.create(sessionId, metadata);
  }

  peek(sessionId: string): Promise<Session | undefined> {
    return this.base.get(sessionId);
  }

  getOrCreate(sessionId: string): Promise<Session> {
    return this.base.getOrCreate(sessionId);
  }

  save(session: Session): Promise<void> {
    return this.base.save(session);
  }

  delete(sessionId: string): Promise<boolean> {
    return this.base.delete(sessionId);
  }
}

function createRuntimeWithStore(sessionStore: SessionStore): AgentRuntime {
  const model: ModelClient = {
    async complete() {
      throw new Error("model must not be called");
    },
  };
  const loop = new AgentLoop({
    model,
    sessionStore,
    tools: new ToolRegistry(),
    requestApproval: async () => false,
  });
  return new AgentRuntime({ loop });
}

test("a pre-aborted createIfMissing prompt does not read or create a Session", async () => {
  const sessionStore = new DelayedReadSessionStore();
  const runtime = createRuntimeWithStore(sessionStore);
  const controller = new AbortController();
  controller.abort(new DOMException("already cancelled", "AbortError"));

  await assert.rejects(runtime.prompt({
    sessionId: "pre-aborted-create",
    content: [{ type: "text", text: "must not create" }],
    createIfMissing: true,
    signal: controller.signal,
  }), { name: "AbortError" });

  assert.equal(sessionStore.getCalls, 0);
  assert.equal(sessionStore.createCalls, 0);
  assert.equal(await sessionStore.peek("pre-aborted-create"), undefined);
});

test("cancellation racing createIfMissing Session lookup prevents creation", async () => {
  const sessionStore = new DelayedReadSessionStore();
  const runtime = createRuntimeWithStore(sessionStore);
  const controller = new AbortController();
  const delayed = sessionStore.delayNextGet();
  const prompting = runtime.prompt({
    sessionId: "abort-during-create-read",
    content: [{ type: "text", text: "must not create" }],
    createIfMissing: true,
    signal: controller.signal,
  });

  await delayed.entered;
  controller.abort(new DOMException("cancel lookup", "AbortError"));
  delayed.release();

  await assert.rejects(prompting, { name: "AbortError" });
  assert.equal(sessionStore.getCalls, 1);
  assert.equal(sessionStore.createCalls, 0);
  assert.equal(await sessionStore.peek("abort-during-create-read"), undefined);
});

test("closeSession gates new prompts and waits for an admitted prompt before deletion", async () => {
  const sessionStore = new DelayedReadSessionStore();
  const tools = new ToolRegistry();
  const model: ModelClient = { async complete() { return { content: "should not complete" }; } };
  tools.register(new ConversationCompressionTool(model));
  const loop = new AgentLoop({
    model,
    sessionStore,
    tools,
    requestApproval: async () => false,
  });
  const runtime = new AgentRuntime({ loop, sessionStore, tools });
  await runtime.createSession({ sessionId: "closing-race" });

  const delayed = sessionStore.delayNextGet();
  const admittedPrompt = runtime.prompt({
    sessionId: "closing-race",
    content: [{ type: "text", text: "already admitted" }],
  });
  await delayed.entered;

  let closeSettled = false;
  const closing = runtime.closeSession("closing-race").then((deleted) => {
    closeSettled = true;
    return deleted;
  });
  await assert.rejects(
    runtime.prompt({
      sessionId: "closing-race",
      content: [{ type: "text", text: "too late" }],
      createIfMissing: true,
    }),
    { name: "SessionClosingError" },
  );
  assert.equal(closeSettled, false);

  delayed.release();
  await assert.rejects(admittedPrompt, { name: "AbortError" });
  assert.equal(await closing, true);
  assert.equal(await runtime.getSession("closing-race"), undefined);
});

test("AgentRuntime derives canonical loop dependencies and rejects split-brain wiring", async () => {
  const sessionStore = new InMemorySessionStore();
  const tools = new ToolRegistry();
  const model: ModelClient = { async complete() { return { content: "ok" }; } };
  tools.register(new ConversationCompressionTool(model));
  const loop = new AgentLoop({
    model,
    sessionStore,
    tools,
    requestApproval: async () => false,
  });

  const runtime = new AgentRuntime({ loop });
  await runtime.createSession({ sessionId: "canonical-dependencies" });
  assert.ok(await sessionStore.get("canonical-dependencies"));

  assert.throws(
    () => new AgentRuntime({
      loop,
      sessionStore: new InMemorySessionStore(),
      tools,
    }),
    { name: "RuntimeDependencyMismatchError" },
  );
  assert.throws(
    () => new AgentRuntime({
      loop,
      sessionStore,
      tools: new ToolRegistry(),
    }),
    { name: "RuntimeDependencyMismatchError" },
  );

  const canonicalSkills = new TestSkillCatalog();
  const skillLoop = new AgentLoop({
    model,
    sessionStore,
    tools,
    skillLoader: canonicalSkills,
    requestApproval: async () => false,
  });
  const skillRuntime = new AgentRuntime({ loop: skillLoop });
  assert.deepEqual(
    (await skillRuntime.capabilities()).skills.map((skill) => skill.name),
    ["review"],
  );
  assert.throws(
    () => new AgentRuntime({ loop: skillLoop, skills: new TestSkillCatalog() }),
    { name: "RuntimeDependencyMismatchError" },
  );
});

test("SessionInfo is detached from canonical metadata and capability scope", async () => {
  const { runtime } = createRuntime({ async complete() { return { content: "unused" }; } });
  const metadata = { profile: { role: "owner" } };
  const created = await runtime.createSession({
    sessionId: "detached-session-info",
    tools: ["echo"],
    metadata,
  });

  metadata.profile.role = "changed-input";
  (created.metadata.profile as { role: string }).role = "changed-output";
  assert.equal(created.metadata["runtime.tools"], undefined);
  if (created.tools.mode === "selected") {
    (created.tools.names as string[]).push("compress_conversation");
  }

  const resumed = await runtime.resumeSession("detached-session-info");
  assert.deepEqual(resumed.metadata.profile, { role: "owner" });
  assert.deepEqual(resumed.tools, { mode: "selected", names: ["echo"] });
  await assert.rejects(
    runtime.prompt({
      sessionId: "detached-session-info",
      content: [{ type: "text", text: "go" }],
      tools: ["compress_conversation"],
    }),
    /not allowed by the session/,
  );

  const reserved = await runtime.createSession({
    sessionId: "reserved-metadata",
    metadata: { "runtime.tools": ["compress_conversation"] },
  });
  assert.deepEqual(reserved.tools, { mode: "all" });
  assert.equal(reserved.metadata["runtime.tools"], undefined);
});

test("Runtime snapshots mutable request inputs at admission", async () => {
  let exposedTools: readonly string[] = [];
  const model: ModelClient = {
    async complete(request) {
      exposedTools = request.tools.map((tool) => tool.name);
      return { content: "done" };
    },
  };
  const { runtime } = createRuntime(model);
  const tools = ["echo"];
  const metadata = { nested: { owner: "original" } };
  const creating = runtime.createSession({
    sessionId: "request-snapshot",
    tools,
    metadata,
  });
  tools.push("compress_conversation");
  metadata.nested.owner = "caller mutation";

  const created = await creating;
  assert.deepEqual(created.tools, { mode: "selected", names: ["echo"] });
  assert.deepEqual(created.metadata.nested, { owner: "original" });

  const turnTools = ["echo"];
  const running = runtime.prompt({
    sessionId: "request-snapshot",
    content: [{ type: "text", text: "go" }],
    tools: turnTools,
  });
  turnTools.push("compress_conversation");
  assert.equal((await running).stopReason, "end_turn");
  assert.deepEqual(exposedTools, ["echo"]);
});

test("live recovery is serialized behind the active turn", async () => {
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  let releaseModel!: () => void;
  const waitForRelease = new Promise<void>((resolve) => { releaseModel = resolve; });
  const model: ModelClient = {
    async complete() {
      markStarted();
      await waitForRelease;
      return { content: "done" };
    },
  };
  const { runtime, sessionStore } = createRuntime(model);
  await runtime.createSession({ sessionId: "live-recovery" });
  const turn = runtime.prompt({
    sessionId: "live-recovery",
    content: [{ type: "text", text: "wait" }],
  });
  await started;

  let recoverySettled = false;
  const recovery = runtime.recoverSession("live-recovery").then((result) => {
    recoverySettled = true;
    return result;
  });
  await new Promise<void>((resolve) => { setImmediate(resolve); });
  assert.equal(recoverySettled, false);

  releaseModel();
  assert.equal((await turn).stopReason, "end_turn");
  assert.deepEqual(await recovery, { recovered: false, interruptedToolCalls: 0 });
  const session = await sessionStore.get("live-recovery");
  assert.equal(session?.runState?.status, "completed");
  assert.equal(session?.messages.some((message) => /InterruptedToolCall/.test(message.content)), false);
});

test("Session close cancels an active Turn before awaiting queued recovery", async () => {
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  let releaseModel!: () => void;
  const release = new Promise<void>((resolve) => { releaseModel = resolve; });
  let aborted = false;
  const { runtime } = createRuntime({
    async complete({ signal }) {
      markStarted();
      signal?.addEventListener("abort", () => { aborted = true; }, { once: true });
      // Ignore cancellation until released so the ordering is observable.
      await release;
      return { content: "too late" };
    },
  });
  await runtime.createSession({ sessionId: "close-beats-recovery" });
  const running = runtime.prompt({
    sessionId: "close-beats-recovery",
    content: [{ type: "text", text: "wait" }],
  });
  await started;
  const recovery = runtime.recoverSession("close-beats-recovery");
  const closing = runtime.closeSession("close-beats-recovery");

  for (let attempt = 0; attempt < 20 && !aborted; attempt += 1) {
    await new Promise<void>((resolve) => { setImmediate(resolve); });
  }
  assert.equal(aborted, true);
  releaseModel();
  await assert.rejects(running, { name: "AbortError" });
  assert.deepEqual(await recovery, { recovered: false, interruptedToolCalls: 0 });
  assert.equal(await closing, true);
});

test("Session close cancels an active Turn before awaiting queued binding migration", async () => {
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  let markAborted!: () => void;
  const aborted = new Promise<void>((resolve) => { markAborted = resolve; });
  const events: string[] = [];
  const { runtime, sessionStore } = createRuntime({
    async complete({ signal }) {
      markStarted();
      return new Promise((_resolve, reject) => {
        const abort = (): void => {
          events.push("model-aborted");
          markAborted();
          reject(signal?.reason);
        };
        if (signal?.aborted) abort();
        else signal?.addEventListener("abort", abort, { once: true });
      });
    },
  });
  const sessionId = "close-beats-binding-migration";
  const workspace = "/trusted/workspace";
  const binding = { kind: "acp.workspace", value: workspace };
  await runtime.createSession({ sessionId, binding });
  const running = runtime.prompt({
    sessionId,
    expectedBinding: binding,
    content: [{ type: "text", text: "wait" }],
  });
  const runningRejected = assert.rejects(running, { name: "AbortError" });
  await started;

  let migrationSettled = false;
  const migrating = runtime.migrateLegacySessionBinding(sessionId, {
    legacyMetadata: { key: "acp.cwd", value: workspace },
    binding,
  }).then((result) => {
    migrationSettled = true;
    events.push("migration-settled");
    return result;
  });
  await new Promise<void>((resolve) => { setImmediate(resolve); });
  assert.equal(migrationSettled, false);

  const closing = runtime.closeSession(sessionId, { expectedBinding: binding }).then((deleted) => {
    events.push("close-settled");
    return deleted;
  });
  await aborted;
  await runningRejected;
  assert.equal((await migrating).created, false);
  assert.equal(await closing, true);
  assert.deepEqual(events, ["model-aborted", "migration-settled", "close-settled"]);
  assert.equal(await sessionStore.get(sessionId), undefined);
});
