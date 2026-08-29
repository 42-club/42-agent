import assert from "node:assert/strict";
import { request as requestHttp } from "node:http";
import test from "node:test";
import {
  AgentLoop,
  AgentRuntime,
  InMemorySessionStore,
  RuntimeError,
  ToolRegistry,
  type ModelClient,
} from "../src/index.js";
import { createAgentRuntimeHttpServer, streamRuntimeTurn } from "../src/channel/index.js";
import { ConversationCompressionTool } from "../src/tools/index.js";

test("different channels can share one canonical server-side session", async () => {
  const model: ModelClient = {
    async complete({ messages }) {
      return { content: `messages=${messages.length}` };
    },
  };
  const tools = new ToolRegistry();
  tools.register(new ConversationCompressionTool(model));
  const sessions = new InMemorySessionStore();
  const loop = new AgentLoop({
    model,
    tools,
    sessionStore: sessions,
    requestApproval: async () => false,
  });
  const agentRuntime = new AgentRuntime({ loop, sessionStore: sessions, tools });
  const server = createAgentRuntimeHttpServer(agentRuntime, { port: 0 });
  const address = await server.listen();
  const url = `http://${address.host}:${address.port}`;
  try {
    const cliItems = [];
    for await (const item of streamRuntimeTurn(url, {
      sessionId: "same-session",
      userInput: "from cli",
    })) cliItems.push(item);
    const webItems = [];
    for await (const item of streamRuntimeTurn(url, {
      sessionId: "same-session",
      userInput: "from web",
    })) webItems.push(item);

    assert.equal(cliItems.find((item) => item.type === "result")?.content, "messages=1");
    assert.equal(webItems.find((item) => item.type === "result")?.content, "messages=3");
    assert.equal((await sessions.getOrCreate("same-session")).messages.length, 4);
  } finally {
    await server.close();
  }
});

test("closing the HTTP server cancels its turns through AgentRuntime", async () => {
  let modelStarted!: () => void;
  const started = new Promise<void>((resolve) => { modelStarted = resolve; });
  const model: ModelClient = {
    async complete({ signal }) {
      modelStarted();
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
  };
  const tools = new ToolRegistry();
  tools.register(new ConversationCompressionTool(model));
  const sessions = new InMemorySessionStore();
  const loop = new AgentLoop({
    model,
    tools,
    sessionStore: sessions,
    requestApproval: async () => false,
  });
  const agentRuntime = new AgentRuntime({ loop, sessionStore: sessions, tools });
  const server = createAgentRuntimeHttpServer(agentRuntime, { port: 0 });
  const address = await server.listen();
  const consuming = (async () => {
    const items = [];
    for await (const item of streamRuntimeTurn(
      `http://${address.host}:${address.port}`,
      { sessionId: "server-close", userInput: "wait" },
    )) items.push(item);
    return items;
  })();

  await started;
  await server.close();
  const items = await consuming;
  assert.equal(items.at(-1)?.type, "error");
  assert.equal((await sessions.get("server-close"))?.runState?.status, "cancelled");
  assert.deepEqual(agentRuntime.activeRuns("server-close"), []);
});

test("closing the HTTP server interrupts a partial request body", async () => {
  let modelCalls = 0;
  const model: ModelClient = {
    async complete() {
      modelCalls += 1;
      return { content: "unused" };
    },
  };
  const sessions = new InMemorySessionStore();
  const loop = new AgentLoop({
    model,
    tools: new ToolRegistry(),
    sessionStore: sessions,
    requestApproval: async () => false,
  });
  const runtime = new AgentRuntime({ loop });
  const server = createAgentRuntimeHttpServer(runtime, { port: 0 });
  const address = await server.listen();
  const accepted = new Promise<void>((resolve) => {
    server.server.once("request", () => resolve());
  });
  const client = requestHttp({
    host: address.host,
    port: address.port,
    path: "/v1/turn",
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": "100",
    },
  });
  client.on("error", () => undefined);
  client.write('{"sessionId":"partial"');
  await accepted;

  const closing = server.close();
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      closing,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("HTTP server close remained blocked on a partial body")),
          500,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
    client.destroy();
    await closing;
  }
  assert.equal(modelCalls, 0);
  assert.equal(await sessions.get("partial"), undefined);
});

test("stopping HTTP stream consumption cancels the server turn", async () => {
  let modelStarted!: () => void;
  let modelAborted!: () => void;
  const started = new Promise<void>((resolve) => { modelStarted = resolve; });
  const aborted = new Promise<void>((resolve) => { modelAborted = resolve; });
  const model: ModelClient = {
    async complete({ signal }) {
      modelStarted();
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          modelAborted();
          reject(signal.reason);
        }, { once: true });
      });
    },
  };
  const tools = new ToolRegistry();
  const sessions = new InMemorySessionStore();
  const loop = new AgentLoop({
    model,
    tools,
    sessionStore: sessions,
    requestApproval: async () => false,
  });
  const runtime = new AgentRuntime({ loop });
  const server = createAgentRuntimeHttpServer(runtime, { port: 0 });
  const address = await server.listen();
  try {
    for await (const _item of streamRuntimeTurn(
      `http://${address.host}:${address.port}`,
      { sessionId: "client-break", userInput: "wait" },
    )) {
      break;
    }
    await started;
    await aborted;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await sessions.get("client-break"))?.runState?.status === "cancelled") break;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    assert.equal((await sessions.get("client-break"))?.runState?.status, "cancelled");
  } finally {
    await server.close();
  }
});

test("HTTP runtime bounds bodies and rejects untrusted browser writes", async () => {
  let modelCalls = 0;
  const model: ModelClient = {
    async complete() {
      modelCalls += 1;
      return { content: "unused" };
    },
  };
  const tools = new ToolRegistry();
  const sessions = new InMemorySessionStore();
  const loop = new AgentLoop({
    model,
    tools,
    sessionStore: sessions,
    requestApproval: async () => false,
  });
  const runtime = new AgentRuntime({ loop });
  const server = createAgentRuntimeHttpServer(runtime, {
    port: 0,
    maxBodyBytes: 64,
    allowedOrigin: "https://trusted.example",
  });
  const address = await server.listen();
  const url = `http://${address.host}:${address.port}`;

  try {
    const tooLarge = await fetch(`${url}/v1/turn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "large", userInput: "x".repeat(128) }),
    });
    assert.equal(tooLarge.status, 413);
    assert.deepEqual(await tooLarge.json(), {
      type: "error",
      code: "PayloadTooLarge",
      message: "Request body exceeds the 64-byte limit",
    });

    const crossOrigin = await fetch(`${url}/v1/turn`, {
      method: "POST",
      headers: { "content-type": "text/plain", origin: "https://untrusted.example" },
      body: JSON.stringify({ sessionId: "csrf", userInput: "go" }),
    });
    assert.equal(crossOrigin.status, 403);
    assert.equal(crossOrigin.headers.get("access-control-allow-origin"), null);

    const wrongContentType = await fetch(`${url}/v1/turn`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ sessionId: "plain", userInput: "go" }),
    });
    assert.equal(wrongContentType.status, 415);
    assert.equal(modelCalls, 0);

    const invalidSessionId = await fetch(`${url}/v1/turn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "\ud800", userInput: "go" }),
    });
    assert.equal(invalidSessionId.status, 400);
    assert.deepEqual(await invalidSessionId.json(), {
      type: "error",
      code: "InvalidSessionId",
      message: "sessionId is invalid",
    });
    assert.equal(modelCalls, 0);

    const trusted = await fetch(`${url}/v1/turn`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://trusted.example",
      },
      body: JSON.stringify({ sessionId: "trusted", userInput: "go" }),
    });
    assert.equal(trusted.status, 200);
    assert.equal(
      trusted.headers.get("access-control-allow-origin"),
      "https://trusted.example",
    );
    assert.equal(modelCalls, 1);
  } finally {
    await server.close();
  }
});

test("HTTP classifies admission failures and redacts internal streaming errors", async () => {
  const secret = "postgresql://admin:super-secret@database.internal/runtime";
  const model: ModelClient = {
    async complete() {
      throw new RuntimeError(`SECRET_${secret}`, secret);
    },
  };
  const sessions = new InMemorySessionStore();
  const loop = new AgentLoop({
    model,
    tools: new ToolRegistry(),
    sessionStore: sessions,
    requestApproval: async () => false,
    config: { retry: { maxAttempts: 1 } },
  });
  const runtime = new AgentRuntime({ loop });
  const server = createAgentRuntimeHttpServer(runtime, { port: 0 });
  const address = await server.listen();
  const url = `http://${address.host}:${address.port}`;

  try {
    const malformed = await fetch(`${url}/v1/turn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not-json",
    });
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json() as { code: string }).code, "MalformedJson");

    const unknownTool = await fetch(`${url}/v1/turn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: "unknown-http-tool",
        userInput: "go",
        tools: ["missing"],
      }),
    });
    assert.equal(unknownTool.status, 400);
    assert.equal(
      (await unknownTool.json() as { code: string }).code,
      "InvalidCapabilitySelection",
    );

    const failedTurn = await fetch(`${url}/v1/turn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "redacted-http-error", userInput: "go" }),
    });
    assert.equal(failedTurn.status, 200);
    const stream = await failedTurn.text();
    assert.doesNotMatch(stream, /super-secret|database\.internal/);
    assert.match(stream, /"code":"InternalError"/);
    assert.match(stream, /"message":"Runtime request failed"/);
  } finally {
    await server.close();
  }
});

test("HTTP progress buffering is bounded and cancels an overflowing turn", async () => {
  let modelCalls = 0;
  const model: ModelClient = {
    async complete() {
      modelCalls += 1;
      return { content: "must not run" };
    },
  };
  const sessions = new InMemorySessionStore();
  const tools = new ToolRegistry();
  const loop = new AgentLoop({
    model,
    tools,
    sessionStore: sessions,
    requestApproval: async () => false,
  });
  const runtime = new AgentRuntime({ loop });
  const server = createAgentRuntimeHttpServer(runtime, {
    port: 0,
    maxEventBufferBytes: 1,
  });
  const address = await server.listen();
  try {
    await assert.rejects(async () => {
      const response = await fetch(`http://${address.host}:${address.port}/v1/turn`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: "overflow", userInput: "go" }),
      });
      await response.text();
    });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await sessions.get("overflow"))?.runState?.status === "cancelled") break;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    assert.equal((await sessions.get("overflow"))?.runState?.status, "cancelled");
    assert.equal(modelCalls, 0);
  } finally {
    await server.close();
  }
});
