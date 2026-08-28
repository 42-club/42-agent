import assert from "node:assert/strict";
import test from "node:test";
import {
  AgentLoop,
  AgentRuntime,
  ConversationCompressionTool,
  InMemorySessionStore,
  ToolRegistry,
  type LoadedSkill,
  type ModelClient,
  type SkillCatalog,
  type Session,
  type SessionStore,
  type Tool,
} from "../src/index.js";

class TestSkillCatalog implements SkillCatalog {
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
  return { runtime: new AgentRuntime({ loop, sessionStore, tools, skills }), sessionStore };
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
  assert.deepEqual(capabilities.skills.map((skill) => skill.name), ["review"]);
  assert.deepEqual(capabilities.tools.map((tool) => tool.name), ["echo", "compress_conversation"]);

  const created = await runtime.createSession({
    sessionId: "runtime-session",
    tools: ["echo"],
    skills: ["review"],
    metadata: { owner: "host-application" },
  });
  assert.equal(created.created, true);
  assert.deepEqual(created.tools, ["echo"]);
  assert.deepEqual(created.skills, ["review"]);

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
    return this.base.create(sessionId, metadata);
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
  (created.metadata["runtime.tools"] as string[]).push("compress_conversation");
  (created.tools as string[]).push("compress_conversation");

  const resumed = await runtime.resumeSession("detached-session-info");
  assert.deepEqual(resumed.metadata.profile, { role: "owner" });
  assert.deepEqual(resumed.tools, ["echo"]);
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
  assert.deepEqual(reserved.tools, []);
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
  assert.deepEqual(created.tools, ["echo"]);
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
