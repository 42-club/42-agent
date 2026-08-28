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
  await assert.rejects(running, { name: "AbortError" });
  assert.equal((await sessionStore.get("cancel-runtime"))?.runState?.status, "cancelled");
  assert.deepEqual(runtime.activeRuns("cancel-runtime"), []);
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
