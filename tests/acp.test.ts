import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  client,
  methods,
  PROTOCOL_VERSION,
  RequestError,
  type AgentContext,
  type AnyMessage,
  type RequestPermissionRequest,
  type SessionNotification,
  type Stream,
} from "@agentclientprotocol/sdk";
import {
  AgentLoop,
  AgentRuntime,
  InMemorySessionStore,
  ToolRegistry,
  type ApprovalHandler,
  type ModelClient,
  type SkillCatalog,
  type Tool,
} from "../src/index.js";
import {
  AcpPermissionBridge,
  AcpUpdateProjector,
  createAcpAgent,
  type AcpAgentOptions,
} from "../src/acp/index.js";

function createRuntime(
  model: ModelClient,
  options: {
    tools?: readonly Tool[];
    requestApproval?: ApprovalHandler;
  } = {},
) {
  const sessionStore = new InMemorySessionStore();
  const tools = new ToolRegistry();
  for (const tool of options.tools ?? []) tools.register(tool);
  const loop = new AgentLoop({
    model,
    sessionStore,
    tools,
    requestApproval: options.requestApproval ?? (async () => false),
  });
  return {
    runtime: new AgentRuntime({ loop }),
    sessionStore,
  };
}

function createTestAcpAgent(
  runtime: AgentRuntime,
  options: Omit<AcpAgentOptions, "workspaceRoot"> = {},
) {
  return createAcpAgent(runtime, { workspaceRoot: process.cwd(), ...options });
}

async function initialize(context: Parameters<Parameters<ReturnType<typeof client>["connectWith"]>[1]>[0]) {
  return context.request(methods.agent.initialize, {
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: {},
    clientInfo: { name: "acp-tests", version: "1.0.0" },
  });
}

test("ACP v1 negotiates honest capabilities and maps session lifecycle", async () => {
  let lastUserInput = "";
  const { runtime } = createRuntime({
    async complete(request) {
      lastUserInput = request.messages.at(-1)?.content ?? "";
      return { content: "done" };
    },
  });
  const updates: SessionNotification[] = [];
  const agent = createTestAcpAgent(runtime, {
    name: "runtime-test-agent",
    title: "Runtime Test Agent",
    version: "1.2.3",
  });
  const testClient = client({ name: "runtime-test-client" })
    .onNotification(methods.client.session.update, ({ params }) => {
      updates.push(params);
    });

  await testClient.connectWith(agent, async (context) => {
    const result = await initialize(context);
    assert.equal(result.protocolVersion, 1);
    assert.equal(result.agentInfo?.name, "runtime-test-agent");
    assert.equal(result.agentCapabilities?.loadSession, false);
    assert.deepEqual(result.agentCapabilities?.promptCapabilities, {});
    assert.deepEqual(result.agentCapabilities?.sessionCapabilities?.resume, {});
    assert.deepEqual(result.agentCapabilities?.sessionCapabilities?.delete, {});
    assert.equal(result.agentCapabilities?.sessionCapabilities?.close, undefined);
    assert.equal(result.agentCapabilities?.mcpCapabilities, undefined);

    const created = await context.request(methods.agent.session.new, {
      cwd: process.cwd(),
      mcpServers: [],
    });
    const promptResult = await context.request(methods.agent.session.prompt, {
      sessionId: created.sessionId,
      prompt: [{
        type: "resource_link",
        uri: "file:///project/README.md",
        name: "README.md",
      }],
    });
    assert.equal(promptResult.stopReason, "end_turn");
    assert.match(lastUserInput, /file:\/\/\/project\/README\.md/);
    assert.deepEqual(
      updates.map((notification) => notification.update.sessionUpdate),
      ["agent_message_chunk"],
    );
    assert.equal(
      updates[0]?.update.sessionUpdate === "agent_message_chunk"
        ? updates[0].update.content.type === "text" && updates[0].update.content.text
        : undefined,
      "done",
    );

    assert.deepEqual(await context.request(methods.agent.session.resume, {
      sessionId: created.sessionId,
      cwd: process.cwd(),
      mcpServers: [],
    }), {});
    assert.deepEqual(await context.request(methods.agent.session.delete, {
      sessionId: created.sessionId,
    }), {});
    // ACP deletion is idempotent.
    assert.deepEqual(await context.request(methods.agent.session.delete, {
      sessionId: created.sessionId,
    }), {});
    await assert.rejects(
      context.request(methods.agent.session.resume, {
        sessionId: created.sessionId,
        cwd: process.cwd(),
        mcpServers: [],
      }),
      (error: unknown) => error instanceof RequestError && error.code === -32002,
    );
  });
});

test("ACP initialize redacts capability-discovery failures", async () => {
  const secret = "INIT_SECRET_SENTINEL";
  const skills: SkillCatalog = {
    async list() {
      throw new Error(secret);
    },
    async load() {
      return [];
    },
  };
  const loop = new AgentLoop({
    model: { async complete() { return { content: "unused" }; } },
    sessionStore: new InMemorySessionStore(),
    tools: new ToolRegistry(),
    skillLoader: skills,
    requestApproval: async () => false,
  });

  await client().connectWith(createTestAcpAgent(new AgentRuntime({ loop })), async (context) => {
    await assert.rejects(
      initialize(context),
      (error: unknown) => error instanceof RequestError
        && error.code === -32603
        && error.data === undefined
        && !error.message.includes(secret),
    );
  });
});

test("ACP adapter admits only one live client connection and allows reconnect", async () => {
  const { runtime } = createRuntime({ async complete() { return { content: "unused" }; } });
  const agent = createTestAcpAgent(runtime);
  const first = client({ name: "first-client" }).connect(agent);
  try {
    await initialize(first.agent);
    const second = client({ name: "second-client" }).connect(agent);
    await assert.rejects(initialize(second.agent), /active client connection|closed/i);
    await second.closed;
  } finally {
    first.close();
    await first.closed;
  }

  const reconnected = client({ name: "reconnected-client" }).connect(agent);
  try {
    const response = await initialize(reconnected.agent);
    assert.equal(response.protocolVersion, PROTOCOL_VERSION);
  } finally {
    reconnected.close();
    await reconnected.closed;
  }
});

test("ACP streams ordered deltas once and shares a message ID", async () => {
  const { runtime } = createRuntime({
    async complete() {
      throw new Error("stream should be used");
    },
    async *stream() {
      yield { type: "text_delta", delta: "hel" } as const;
      yield { type: "text_delta", delta: "lo" } as const;
      yield { type: "done", response: { content: "hello!" } } as const;
    },
  });
  const chunks: Array<{ text: string; messageId?: string | null }> = [];
  const testClient = client()
    .onNotification(methods.client.session.update, ({ params }) => {
      if (params.update.sessionUpdate === "agent_message_chunk"
        && params.update.content.type === "text") {
        chunks.push({
          text: params.update.content.text,
          messageId: params.update.messageId,
        });
      }
    });

  await testClient.connectWith(createTestAcpAgent(runtime), async (context) => {
    await initialize(context);
    const { sessionId } = await context.request(methods.agent.session.new, {
      cwd: process.cwd(),
      mcpServers: [],
    });
    assert.deepEqual(await context.request(methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: "text", text: "hello" }],
    }), { stopReason: "end_turn" });
  });

  assert.deepEqual(chunks.map((chunk) => chunk.text), ["hel", "lo", "!"]);
  assert.equal(chunks[0]?.messageId, chunks[1]?.messageId);
  assert.equal(chunks[1]?.messageId, chunks[2]?.messageId);
  assert.ok(chunks[0]?.messageId);
});

test("ACP publishes a divergent canonical stream result with a new message ID", async () => {
  const { runtime } = createRuntime({
    async complete() {
      throw new Error("stream should be used");
    },
    async *stream() {
      yield { type: "text_delta", delta: "draft" } as const;
      yield { type: "done", response: { content: "canonical final" } } as const;
    },
  });
  const chunks: Array<{ text: string; messageId?: string | null }> = [];
  const testClient = client()
    .onNotification(methods.client.session.update, ({ params }) => {
      if (params.update.sessionUpdate === "agent_message_chunk"
        && params.update.content.type === "text") {
        chunks.push({ text: params.update.content.text, messageId: params.update.messageId });
      }
    });

  await testClient.connectWith(createTestAcpAgent(runtime), async (context) => {
    await initialize(context);
    const { sessionId } = await context.request(methods.agent.session.new, {
      cwd: process.cwd(),
      mcpServers: [],
    });
    assert.deepEqual(await context.request(methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: "text", text: "go" }],
    }), { stopReason: "end_turn" });
  });

  assert.deepEqual(chunks.map((chunk) => chunk.text), ["draft", "canonical final"]);
  assert.notEqual(chunks[0]?.messageId, chunks[1]?.messageId);
});

test("ACP session/cancel aborts the Runtime and returns the cancelled stop reason", async () => {
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const { runtime, sessionStore } = createRuntime({
    async complete(request) {
      markStarted();
      return new Promise((_resolve, reject) => {
        request.signal?.addEventListener("abort", () => reject(request.signal?.reason), { once: true });
      });
    },
  });

  await client().connectWith(createTestAcpAgent(runtime), async (context) => {
    await initialize(context);
    const { sessionId } = await context.request(methods.agent.session.new, {
      cwd: process.cwd(),
      mcpServers: [],
    });
    const pending = context.request(methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: "text", text: "wait" }],
    });
    await started;
    await context.notify(methods.agent.session.cancel, { sessionId });
    assert.deepEqual(await pending, { stopReason: "cancelled" });
    assert.equal((await sessionStore.get(sessionId))?.runState?.status, "cancelled");
  });
});

test("ACP request cancellation propagates through the SDK handler signal", async () => {
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const { runtime, sessionStore } = createRuntime({
    async complete(request) {
      markStarted();
      return new Promise((_resolve, reject) => {
        request.signal?.addEventListener("abort", () => reject(request.signal?.reason), { once: true });
      });
    },
  });

  await client().connectWith(createTestAcpAgent(runtime), async (context) => {
    await initialize(context);
    const { sessionId } = await context.request(methods.agent.session.new, {
      cwd: process.cwd(),
      mcpServers: [],
    });
    const cancellation = new AbortController();
    const pending = context.request(methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: "text", text: "wait" }],
    }, { cancellationSignal: cancellation.signal });
    await started;
    cancellation.abort(new DOMException("cancel request", "AbortError"));
    assert.deepEqual(await pending, { stopReason: "cancelled" });
    assert.equal((await sessionStore.get(sessionId))?.runState?.status, "cancelled");
  });
});

test("ACP cancel during final update delivery returns cancelled", async (t) => {
  const { runtime } = createRuntime({ async complete() { return { content: "done" }; } });
  const streams = gatedSessionUpdateStreams();
  const agentConnection = createTestAcpAgent(runtime, {
    updateDeliveryTimeoutMs: 5_000,
  }).connect(streams.agent);
  t.after(() => agentConnection.close());
  const testClient = client()
    .onNotification(methods.client.session.update, () => undefined);

  await testClient.connectWith(streams.client, async (context) => {
    await initialize(context);
    const { sessionId } = await context.request(methods.agent.session.new, {
      cwd: process.cwd(),
      mcpServers: [],
    });
    const prompt = context.request(methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: "text", text: "finish, then cancel during delivery" }],
    });
    await streams.deliveryStarted;
    await context.notify(methods.agent.session.cancel, { sessionId });
    await new Promise<void>((resolve) => { setTimeout(resolve, 10); });
    streams.releaseDelivery();
    assert.deepEqual(await prompt, { stopReason: "cancelled" });
  });
});

test("ACP permission bridge uses the client decision for the active tool call", async () => {
  const bridge = new AcpPermissionBridge();
  let approved: boolean | undefined;
  const dangerous: Tool = {
    name: "dangerous_write",
    description: "Writes remote state",
    inputSchema: { type: "object", additionalProperties: false },
    executionPolicy: "exclusive",
    async execute(_arguments, context) {
      approved = await context.requestApproval("Allow the dangerous write?");
      return { approved };
    },
  };
  let modelCall = 0;
  const { runtime } = createRuntime({
    async complete() {
      modelCall += 1;
      return modelCall === 1
        ? {
          content: "",
          toolCalls: [{ id: "call-approval", name: "dangerous_write", arguments: {} }],
        }
        : { content: "finished" };
    },
  }, {
    tools: [dangerous],
    requestApproval: bridge.requestApproval,
  });
  let permission: RequestPermissionRequest | undefined;
  const updateKinds: string[] = [];
  const testClient = client()
    .onRequest(methods.client.session.requestPermission, ({ params }) => {
      permission = params;
      const allow = params.options.find((option) => option.kind === "allow_once");
      assert.ok(allow);
      return { outcome: { outcome: "selected", optionId: allow.optionId } };
    })
    .onNotification(methods.client.session.update, ({ params }) => {
      updateKinds.push(params.update.sessionUpdate);
    });

  await testClient.connectWith(createTestAcpAgent(runtime, { permissionBridge: bridge }), async (context) => {
    await initialize(context);
    const { sessionId } = await context.request(methods.agent.session.new, {
      cwd: process.cwd(),
      mcpServers: [],
    });
    assert.deepEqual(await context.request(methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: "text", text: "do it" }],
    }), { stopReason: "end_turn" });
  });

  assert.equal(approved, true);
  assert.equal(permission?.toolCall.toolCallId, "call-approval");
  assert.equal(permission?.toolCall.title, "Allow the dangerous write?");
  assert.deepEqual(updateKinds, [
    "tool_call",
    "tool_call_update",
    "agent_message_chunk",
  ]);
});

test("ACP session/delete cancels an in-flight permission request before deleting", async () => {
  const bridge = new AcpPermissionBridge();
  let markPermissionStarted!: () => void;
  const permissionStarted = new Promise<void>((resolve) => { markPermissionStarted = resolve; });
  let markPermissionCancelled!: () => void;
  const permissionCancelled = new Promise<void>((resolve) => { markPermissionCancelled = resolve; });
  const tool = plainApprovalTool();
  let modelCall = 0;
  const { runtime, sessionStore } = createRuntime({
    async complete() {
      modelCall += 1;
      return modelCall === 1
        ? { toolCalls: [{ id: "delete-approval", name: tool.name, arguments: {} }] }
        : { content: "unexpected" };
    },
  }, { tools: [tool], requestApproval: bridge.requestApproval });
  const testClient = client()
    .onRequest(methods.client.session.requestPermission, ({ signal }) => {
      markPermissionStarted();
      return new Promise((resolve) => {
        const cancel = (): void => {
          markPermissionCancelled();
          resolve({ outcome: { outcome: "cancelled" } });
        };
        if (signal.aborted) cancel();
        else signal.addEventListener("abort", cancel, { once: true });
      });
    });

  await testClient.connectWith(createTestAcpAgent(runtime, { permissionBridge: bridge }), async (context) => {
    await initialize(context);
    const { sessionId } = await context.request(methods.agent.session.new, {
      cwd: process.cwd(),
      mcpServers: [],
    });
    const prompt = context.request(methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: "text", text: "delete during approval" }],
    });
    await permissionStarted;
    assert.deepEqual(await context.request(methods.agent.session.delete, { sessionId }), {});
    assert.deepEqual(await prompt, { stopReason: "cancelled" });
    await permissionCancelled;
    assert.equal(await sessionStore.get(sessionId), undefined);
  });
});

test("Runtime.close cancels ACP permission scope left outside its internal controller", async () => {
  const bridge = new AcpPermissionBridge();
  let markPermissionStarted!: () => void;
  const permissionStarted = new Promise<void>((resolve) => { markPermissionStarted = resolve; });
  let markPermissionCancelled!: () => void;
  const permissionCancelled = new Promise<void>((resolve) => { markPermissionCancelled = resolve; });
  const tool = plainApprovalTool();
  const { runtime } = createRuntime({
    async complete() {
      return { toolCalls: [{ id: "close-approval", name: tool.name, arguments: {} }] };
    },
  }, { tools: [tool], requestApproval: bridge.requestApproval });
  const testClient = client()
    .onRequest(methods.client.session.requestPermission, ({ signal }) => {
      markPermissionStarted();
      return new Promise((resolve) => {
        const cancel = (): void => {
          markPermissionCancelled();
          resolve({ outcome: { outcome: "cancelled" } });
        };
        if (signal.aborted) cancel();
        else signal.addEventListener("abort", cancel, { once: true });
      });
    });

  await testClient.connectWith(createTestAcpAgent(runtime, { permissionBridge: bridge }), async (context) => {
    await initialize(context);
    const { sessionId } = await context.request(methods.agent.session.new, {
      cwd: process.cwd(),
      mcpServers: [],
    });
    const prompt = context.request(methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: "text", text: "close during approval" }],
    });
    await permissionStarted;
    await runtime.close();
    assert.deepEqual(await prompt, { stopReason: "cancelled" });
    await permissionCancelled;
  });
});

test("ACP rejects unsupported content and ACP-managed MCP servers precisely", async () => {
  const { runtime } = createRuntime({ async complete() { return { content: "unused" }; } });
  await client().connectWith(createTestAcpAgent(runtime), async (context) => {
    await initialize(context);
    await assert.rejects(
      context.request(methods.agent.session.new, {
        cwd: process.cwd(),
        mcpServers: [{ name: "local", command: "/bin/false", args: [], env: [] }],
      }),
      (error: unknown) => error instanceof RequestError
        && error.code === -32602
        && /MCP server connections/.test(error.message),
    );
    await assert.rejects(
      context.request(methods.agent.session.new, {
        cwd: "relative/project",
        mcpServers: [],
      }),
      (error: unknown) => error instanceof RequestError
        && error.code === -32602
        && /absolute path/.test(error.message),
    );
    const { sessionId } = await context.request(methods.agent.session.new, {
      cwd: process.cwd(),
      mcpServers: [],
    });
    await assert.rejects(
      context.request(methods.agent.session.resume, {
        sessionId,
        cwd: "/",
        mcpServers: [],
      }),
      (error: unknown) => error instanceof RequestError
        && error.code === -32602
        && /configured workspace root/.test(error.message)
        && !JSON.stringify(error.data).includes(process.cwd()),
    );
    await assert.rejects(
      context.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "image", data: "AA==", mimeType: "image/png" }],
      }),
      (error: unknown) => error instanceof RequestError
        && error.code === -32602
        && /unsupported prompt content type image/.test(error.message),
    );
  });
});

test("ACP accepts a symlink alias for the configured canonical workspace", async (t) => {
  const container = await mkdtemp(join(tmpdir(), "42-agent-acp-workspace-"));
  t.after(() => rm(container, { recursive: true, force: true }));
  const workspace = join(container, "workspace");
  const alias = join(container, "workspace-alias");
  await mkdir(workspace);
  await symlink(workspace, alias, "dir");
  const { runtime } = createRuntime({ async complete() { return { content: "unused" }; } });
  const agent = createAcpAgent(runtime, { workspaceRoot: workspace });

  await client().connectWith(agent, async (context) => {
    await initialize(context);
    const { sessionId } = await context.request(methods.agent.session.new, {
      cwd: alias,
      mcpServers: [],
    });
    assert.equal((await runtime.getSession(sessionId))?.metadata["acp.cwd"], undefined);
    assert.deepEqual(await context.request(methods.agent.session.resume, {
      sessionId,
      cwd: alias,
      mcpServers: [],
    }), {});
  });
});

test("ACP cannot be tricked into adopting a foreign Session through generic metadata", async () => {
  const { runtime } = createRuntime({ async complete() { return { content: "unused" }; } });
  const forgedWorkspace = await realpath(process.cwd());
  await runtime.createSession({
    sessionId: "foreign-session",
    metadata: { "acp.cwd": forgedWorkspace },
  });

  await client().connectWith(createTestAcpAgent(runtime), async (context) => {
    await initialize(context);
    await assert.rejects(
      context.request(methods.agent.session.resume, {
        sessionId: "foreign-session",
        cwd: process.cwd(),
        mcpServers: [],
      }),
      (error: unknown) => error instanceof RequestError
        && error.code === -32002
        && !JSON.stringify(error).includes(forgedWorkspace),
    );
    await assert.rejects(
      context.request(methods.agent.session.prompt, {
        sessionId: "foreign-session",
        prompt: [{ type: "text", text: "must not cross the adapter boundary" }],
      }),
      (error: unknown) => error instanceof RequestError && error.code === -32002,
    );
    assert.deepEqual(
      await context.request(methods.agent.session.delete, { sessionId: "foreign-session" }),
      {},
    );
  });
  assert.ok(await runtime.getSession("foreign-session"));
});

test("ACP cancel ignores a foreign turn not admitted by this adapter", async () => {
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const { runtime } = createRuntime({
    async complete(request) {
      markStarted();
      return new Promise((_resolve, reject) => {
        request.signal?.addEventListener("abort", () => reject(request.signal?.reason), { once: true });
      });
    },
  });
  await runtime.createSession({ sessionId: "foreign-active" });
  const foreignTurn = runtime.prompt({
    sessionId: "foreign-active",
    content: [{ type: "text", text: "embedded host turn" }],
  });
  await started;

  await client().connectWith(createTestAcpAgent(runtime), async (context) => {
    await initialize(context);
    await context.notify(methods.agent.session.cancel, { sessionId: "foreign-active" });
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    assert.equal(runtime.activeRuns("foreign-active").length, 1);
  });
  assert.equal(runtime.cancel("foreign-active", "test cleanup"), true);
  await assert.rejects(foreignTurn, { name: "AbortError" });
});

test("ACP bounds pending session updates and cancels on backpressure", async () => {
  const { runtime, sessionStore } = createRuntime({
    async complete() {
      throw new Error("stream should be used");
    },
    async *stream() {
      yield { type: "text_delta", delta: "one" } as const;
      yield { type: "text_delta", delta: "two" } as const;
      yield { type: "done", response: { content: "onetwo" } } as const;
    },
  });
  const testClient = client()
    .onNotification(methods.client.session.update, async () => {
      await new Promise<void>((resolve) => { setTimeout(resolve, 10); });
    });

  await testClient.connectWith(createTestAcpAgent(runtime, { maxPendingUpdates: 1 }), async (context) => {
    await initialize(context);
    const { sessionId } = await context.request(methods.agent.session.new, {
      cwd: process.cwd(),
      mcpServers: [],
    });
    await assert.rejects(
      context.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text: "overflow" }],
      }),
      (error: unknown) => error instanceof RequestError
        && error.code === -32603
        && error.data === undefined
        && /agent runtime request failed/.test(error.message),
    );
    assert.equal((await sessionStore.get(sessionId))?.runState?.status, "cancelled");
  });
});

test("ACP cancellation does not wait for a hung session update delivery", async () => {
  let markDeliveryStarted!: () => void;
  const deliveryStarted = new Promise<void>((resolve) => { markDeliveryStarted = resolve; });
  const { runtime } = createRuntime({
    async complete() {
      throw new Error("stream should be used");
    },
    async *stream(request) {
      yield { type: "text_delta", delta: "partial" } as const;
      await new Promise<never>((_resolve, reject) => {
        request.signal?.addEventListener("abort", () => reject(request.signal?.reason), { once: true });
      });
    },
  });
  const testClient = client()
    .onNotification(methods.client.session.update, () => {
      markDeliveryStarted();
      return new Promise<void>(() => undefined);
    });

  await testClient.connectWith(createTestAcpAgent(runtime, {
    updateDeliveryTimeoutMs: 5_000,
  }), async (context) => {
    await initialize(context);
    const { sessionId } = await context.request(methods.agent.session.new, {
      cwd: process.cwd(),
      mcpServers: [],
    });
    const pending = context.request(methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: "text", text: "wait" }],
    });
    await deliveryStarted;
    await context.notify(methods.agent.session.cancel, { sessionId });
    assert.deepEqual(await pending, { stopReason: "cancelled" });
  });
});

test("ACP update timeout observes a transport promise that rejects later", async () => {
  let rejectDelivery!: (error: Error) => void;
  let markDeliveryStarted!: () => void;
  const deliveryStarted = new Promise<void>((resolve) => { markDeliveryStarted = resolve; });
  const delivery = new Promise<void>((_resolve, reject) => {
    rejectDelivery = reject;
  });
  const controller = new AbortController();
  const projector = new AcpUpdateProjector({
    sessionId: "delivery-timeout",
    client: {
      notify() {
        markDeliveryStarted();
        return delivery;
      },
    } as unknown as AgentContext,
    maxPendingUpdates: 2,
    signal: controller.signal,
    deliveryTimeoutMs: 5,
    onFailure: (error) => controller.abort(error),
  });
  projector.observe({
    type: "text_delta",
    sessionId: "delivery-timeout",
    runId: "run-timeout",
    delta: "blocked",
  });
  await deliveryStarted;
  await assert.rejects(projector.drain(), /delivery exceeded/);
  rejectDelivery(new Error("late transport failure"));
  await new Promise<void>((resolve) => { setImmediate(resolve); });
});

test("ACP projector cancellation releases a hung transport delivery", async () => {
  let markDeliveryStarted!: () => void;
  const deliveryStarted = new Promise<void>((resolve) => { markDeliveryStarted = resolve; });
  const delivery = new Promise<void>(() => undefined);
  let deliveries = 0;
  const controller = new AbortController();
  const projector = new AcpUpdateProjector({
    sessionId: "delivery-cancel",
    client: {
      notify() {
        deliveries += 1;
        markDeliveryStarted();
        return delivery;
      },
    } as unknown as AgentContext,
    maxPendingUpdates: 2,
    signal: controller.signal,
    deliveryTimeoutMs: 5_000,
    onFailure: (error) => controller.abort(error),
  });
  projector.observe({
    type: "text_delta",
    sessionId: "delivery-cancel",
    runId: "run-cancel",
    delta: "blocked",
  });
  projector.observe({
    type: "text_delta",
    sessionId: "delivery-cancel",
    runId: "run-cancel",
    delta: "must not be delivered after cancellation",
  });
  await deliveryStarted;
  controller.abort(new DOMException("cancel", "AbortError"));
  await projector.drain();
  assert.equal(projector.failure, undefined);
  assert.equal(deliveries, 1);
});

test("ACP projector redacts Tool failure details", async () => {
  const delivered: unknown[] = [];
  const controller = new AbortController();
  const projector = new AcpUpdateProjector({
    sessionId: "redacted-tool-failure",
    client: {
      notify(_method: unknown, params: unknown) {
        delivered.push(params);
        return Promise.resolve();
      },
    } as unknown as AgentContext,
    maxPendingUpdates: 2,
    signal: controller.signal,
    deliveryTimeoutMs: 1_000,
    onFailure: (error) => controller.abort(error),
  });

  projector.observe({
    type: "tool_call_failed",
    sessionId: "redacted-tool-failure",
    runId: "run-redacted",
    call: { id: "call-redacted", name: "private_tool", arguments: {} },
    error: "postgresql://admin:secret@internal.invalid/database",
  });
  await projector.drain();

  const wire = JSON.stringify(delivered);
  assert.doesNotMatch(wire, /admin|secret|internal\.invalid/);
  assert.match(wire, /Tool call failed/);
});

test("ACP permission bridge defaults to deny outside an ACP prompt", async () => {
  assert.equal(await new AcpPermissionBridge().requestApproval("outside"), false);
  let question = "";
  const bridge = new AcpPermissionBridge({
    fallback: async (value) => {
      question = value;
      return true;
    },
  });
  assert.equal(await bridge.requestApproval("embedded host"), true);
  assert.equal(question, "embedded host");
  assert.throws(
    () => createTestAcpAgent(
      createRuntime({ async complete() { return { content: "unused" }; } }).runtime,
      { maxPendingUpdates: 0 },
    ),
    RangeError,
  );
});

function plainApprovalTool(): Tool {
  return {
    name: "approval_required",
    description: "Waits for approval",
    inputSchema: { type: "object", additionalProperties: false },
    executionPolicy: "exclusive",
    async execute(_arguments, context) {
      // Deliberately does not inspect ToolContext.signal. ToolRegistry must bind
      // the canonical turn signal into the approval handler itself.
      return context.requestApproval("Allow this operation?");
    },
  };
}

function gatedSessionUpdateStreams(): {
  agent: Stream;
  client: Stream;
  deliveryStarted: Promise<void>;
  releaseDelivery: () => void;
} {
  const clientToAgent = new TransformStream<AnyMessage, AnyMessage>();
  let markDeliveryStarted!: () => void;
  const deliveryStarted = new Promise<void>((resolve) => { markDeliveryStarted = resolve; });
  let releaseDelivery!: () => void;
  const deliveryGate = new Promise<void>((resolve) => { releaseDelivery = resolve; });
  let gated = false;
  const agentToClient = new TransformStream<AnyMessage, AnyMessage>({
    async transform(message, controller) {
      if (!gated && "method" in message && message.method === methods.client.session.update) {
        gated = true;
        markDeliveryStarted();
        await deliveryGate;
      }
      controller.enqueue(message);
    },
  });
  return {
    agent: {
      readable: clientToAgent.readable,
      writable: agentToClient.writable,
    },
    client: {
      readable: agentToClient.readable,
      writable: clientToAgent.writable,
    },
    deliveryStarted,
    releaseDelivery,
  };
}
