import assert from "node:assert/strict";
import test from "node:test";
import {
  loadMCPTools,
  MCPProtocolError,
  MCPToolCallError,
  MCPToolProvider,
  MCPToolProviderClosedError,
  type MCPClient,
} from "../src/index.js";
import type { ToolContext } from "../src/tools/base.js";

const baseContext: ToolContext = {
  session: { id: "mcp", messages: [], metadata: {} },
  requestApproval: async () => false,
};

test("MCP tools propagate the runtime cancellation signal", async () => {
  let receivedSignal: AbortSignal | undefined;
  const [tool] = await loadMCPTools({
    async listTools() {
      return [{
        name: "remote",
        inputSchema: { type: "object" },
        annotations: { readOnlyHint: true },
      }];
    },
    async callTool(_name, _arguments, options) {
      receivedSignal = options?.signal;
      return "ok";
    },
  });
  const controller = new AbortController();

  await tool!.execute({}, {
    ...baseContext,
    signal: controller.signal,
    requestApproval: async () => true,
  });

  assert.equal(receivedSignal, controller.signal);
});

test("MCP annotations produce conservative defaults, scheduling, and structured descriptions", async () => {
  const tools = await loadMCPTools({
    async listTools() {
      return [
        {
          name: "search",
          title: "Knowledge search",
          description: "Search indexed documents.",
          inputSchema: { type: "object" },
          outputSchema: { type: "object", properties: { hits: { type: "array" } } },
          annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
          },
          _meta: { owner: "docs" },
        },
        { name: "unannotated" },
        {
          name: "ordered_read",
          annotations: { readOnlyHint: true },
        },
      ];
    },
    async callTool() {
      return "ok";
    },
  }, {
    trustToolAnnotations: true,
    executionPolicyFor: (definition) => (
      definition.name === "ordered_read" ? "exclusive" : undefined
    ),
  });
  const [search, unannotated, orderedRead] = tools;

  assert.equal(search!.executionPolicy, "parallel");
  assert.equal(search!.mcp.title, "Knowledge search");
  assert.equal(search!.mcp.annotationsTrusted, true);
  assert.deepEqual(search!.mcp.annotations, {
    title: undefined,
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  });
  assert.deepEqual(search!.mcp.outputSchema, {
    type: "object",
    properties: { hits: { type: "array" } },
  });
  assert.deepEqual(search!.mcp._meta, { owner: "docs" });
  assert.match(search!.description, /MCP title: Knowledge search/);
  assert.match(search!.description, /"readOnlyHint":true/);
  assert.match(search!.description, /"openWorldHint":false/);

  assert.equal(unannotated!.executionPolicy, "exclusive");
  assert.deepEqual(unannotated!.mcp.annotations, {
    title: undefined,
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  });
  assert.equal(orderedRead!.executionPolicy, "exclusive");
});

test("untrusted annotations cannot bypass approval or exclusive execution", async () => {
  let approvals = 0;
  let remoteCalls = 0;
  const client: MCPClient = {
    async listTools() {
      return [
        {
          name: "claimed_read",
          annotations: {
            title: "Harmless search",
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
          },
        },
        {
          name: "forged_override",
          annotations: { readOnlyHint: true },
          // An untrusted server may send non-standard extra fields.
          executionPolicy: "parallel" as const,
        },
      ];
    },
    async callTool() {
      remoteCalls += 1;
      return "unexpected";
    },
  };
  const [claimedReadOnly, forgedOverride] = await loadMCPTools(client);

  assert.equal(claimedReadOnly!.executionPolicy, "exclusive");
  assert.equal(claimedReadOnly!.mcp.annotationsTrusted, false);
  assert.match(claimedReadOnly!.description, /"trusted":false/);
  assert.equal(forgedOverride!.executionPolicy, "exclusive");
  const [, localOverride] = await loadMCPTools(client, {
    executionPolicyFor: (definition) => (
      definition.name === "forged_override" ? "parallel" : undefined
    ),
  });
  assert.equal(localOverride!.executionPolicy, "parallel");
  const declined = await claimedReadOnly!.execute({}, {
    ...baseContext,
    requestApproval: async (question) => {
      approvals += 1;
      assert.match(question, /"claimed_read" \(server title "Harmless search"\)/);
      assert.match(question, /behavior annotations are not trusted/);
      return false;
    },
  });

  assert.equal(approvals, 1);
  assert.equal(remoteCalls, 0);
  assert.deepEqual(declined, {
    approved: false,
    executed: false,
    error: "MCPToolApprovalDenied",
    message: "MCP tool \"claimed_read\" was not approved",
  });
});

test("trusted read-only MCP tools skip approval while mutating and destructive tools require it", async () => {
  const called: string[] = [];
  const tools = await loadMCPTools({
    async listTools() {
      return [
        { name: "read", annotations: { readOnlyHint: true } },
        {
          name: "add",
          annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: true,
          },
        },
        { name: "destroy" },
      ];
    },
    async callTool(name) {
      called.push(name);
      return { content: [{ type: "text", text: "ok" }] };
    },
  }, { trustToolAnnotations: true });

  await tools[0]!.execute({}, {
    ...baseContext,
    requestApproval: async () => {
      throw new Error("read-only calls must not request approval");
    },
  });

  let additivePrompt = "";
  const declined = await tools[1]!.execute({ value: 1 }, {
    ...baseContext,
    requestApproval: async (question) => {
      additivePrompt = question;
      return false;
    },
  });
  assert.deepEqual(declined, {
    approved: false,
    executed: false,
    error: "MCPToolApprovalDenied",
    message: "MCP tool \"add\" was not approved",
  });
  assert.match(additivePrompt, /may modify remote state/);
  assert.match(additivePrompt, /reports this operation as idempotent/);
  assert.match(additivePrompt, /"value":1/);

  let destructivePrompt = "";
  await tools[2]!.execute({}, {
    ...baseContext,
    requestApproval: async (question) => {
      destructivePrompt = question;
      return true;
    },
  });
  assert.match(destructivePrompt, /destructive remote changes/);
  assert.deepEqual(called, ["read", "destroy"]);
});

test("cancellation interrupts a pending MCP approval and prevents the remote call", async () => {
  let approvalStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    approvalStarted = resolve;
  });
  let remoteCalls = 0;
  const [tool] = await loadMCPTools({
    async listTools() {
      return [{ name: "write", annotations: { readOnlyHint: false } }];
    },
    async callTool() {
      remoteCalls += 1;
      return "unexpected";
    },
  });
  const controller = new AbortController();
  const pending = tool!.execute({}, {
    ...baseContext,
    signal: controller.signal,
    requestApproval: async () => {
      approvalStarted();
      return new Promise<boolean>(() => undefined);
    },
  });
  await started;
  controller.abort(new DOMException("cancelled", "AbortError"));

  await assert.rejects(pending, (error: unknown) => (
    error instanceof DOMException && error.name === "AbortError"
  ));
  assert.equal(remoteCalls, 0);
});

test("MCP isError results and protocol error envelopes become typed failures", async () => {
  const [
    toolError,
    structuredError,
    protocolError,
    rawToolError,
    businessError,
    success,
  ] = await loadMCPTools({
    async listTools() {
      return [
        "tool_error",
        "structured_error",
        "protocol_error",
        "raw_tool_error",
        "business_error",
        "success",
      ].map((name) => ({ name, annotations: { readOnlyHint: true } }));
    },
    async callTool(name) {
      if (name === "tool_error") {
        return {
          isError: true,
          content: [
            { type: "text", text: "invalid date" },
            { type: "text", text: "use ISO-8601" },
          ],
        };
      }
      if (name === "structured_error") {
        return { isError: true, structuredContent: { reason: "conflict" } };
      }
      if (name === "protocol_error") {
        return { jsonrpc: "2.0", error: { code: -32602, message: "Invalid params" } };
      }
      if (name === "raw_tool_error") {
        return {
          jsonrpc: "2.0",
          id: 1,
          result: { isError: true, content: [{ type: "text", text: "nested failure" }] },
        };
      }
      if (name === "business_error") {
        return { error: "a legitimate business value", value: 42 };
      }
      return {
        jsonrpc: "2.0",
        id: 2,
        result: { isError: false, content: [{ type: "text", text: "done" }] },
      };
    },
  }, { trustToolAnnotations: true });

  await assert.rejects(toolError!.execute({}, baseContext), (error: unknown) => {
    assert.ok(error instanceof MCPToolCallError);
    assert.equal(error.toolName, "tool_error");
    assert.match(error.message, /invalid date\nuse ISO-8601/);
    assert.equal(error.result.isError, true);
    return true;
  });
  await assert.rejects(structuredError!.execute({}, baseContext), (error: unknown) => {
    assert.ok(error instanceof MCPToolCallError);
    assert.match(error.message, /"reason":"conflict"/);
    return true;
  });
  await assert.rejects(protocolError!.execute({}, baseContext), (error: unknown) => {
    assert.ok(error instanceof MCPProtocolError);
    assert.equal(error.toolName, "protocol_error");
    assert.match(error.message, /Invalid params \(-32602\)/);
    return true;
  });
  await assert.rejects(rawToolError!.execute({}, baseContext), (error: unknown) => {
    assert.ok(error instanceof MCPToolCallError);
    assert.match(error.message, /nested failure/);
    return true;
  });
  assert.deepEqual(await businessError!.execute({}, baseContext), {
    error: "a legitimate business value",
    value: 42,
  });
  assert.deepEqual(await success!.execute({}, baseContext), {
    isError: false,
    content: [{ type: "text", text: "done" }],
  });
});

test("MCPToolProvider refreshes snapshots, forwards list cancellation, and closes once", async () => {
  let definitions = [{ name: "first", annotations: { readOnlyHint: true } }];
  let listSignal: AbortSignal | undefined;
  let closeCalls = 0;
  const client: MCPClient = {
    async listTools(options) {
      listSignal = options?.signal;
      return definitions;
    },
    async callTool(name) {
      return name;
    },
    async close() {
      closeCalls += 1;
    },
  };
  const provider = new MCPToolProvider(client);
  const controller = new AbortController();
  const firstSnapshot = await provider.load({ signal: controller.signal });
  assert.equal(listSignal, controller.signal);
  assert.deepEqual(firstSnapshot.map((tool) => tool.name), ["first"]);
  assert.deepEqual(provider.tools.map((tool) => tool.name), ["first"]);

  definitions = [{ name: "second", annotations: { readOnlyHint: true } }];
  const secondSnapshot = await provider.refresh();
  assert.deepEqual(secondSnapshot.map((tool) => tool.name), ["second"]);
  assert.deepEqual(provider.tools.map((tool) => tool.name), ["second"]);

  await Promise.all([provider.close(), provider.close()]);
  assert.equal(closeCalls, 1);
  assert.deepEqual(provider.tools, []);
  await assert.rejects(
    firstSnapshot[0]!.execute({}, baseContext),
    MCPToolProviderClosedError,
  );
  await assert.rejects(provider.refresh(), MCPToolProviderClosedError);
});

test("MCPToolProvider rejects duplicate definitions without replacing its last snapshot", async () => {
  let duplicate = false;
  const provider = new MCPToolProvider({
    async listTools() {
      return duplicate
        ? [{ name: "same" }, { name: "same" }]
        : [{ name: "stable", annotations: { readOnlyHint: true } }];
    },
    async callTool() {
      return "ok";
    },
  });
  await provider.load();
  duplicate = true;

  await assert.rejects(provider.refresh(), /Duplicate MCP tool definition: same/);
  assert.deepEqual(provider.tools.map((tool) => tool.name), ["stable"]);
});

test("a slower MCP refresh cannot overwrite a newer snapshot", async () => {
  const pending: Array<(definitions: Array<{
    name: string;
    annotations: { readOnlyHint: boolean };
  }>) => void> = [];
  const provider = new MCPToolProvider({
    listTools() {
      return new Promise((resolve) => pending.push(resolve));
    },
    async callTool() {
      return "ok";
    },
  }, { trustToolAnnotations: true });

  const older = provider.refresh();
  const newer = provider.refresh();
  await Promise.resolve();
  pending[1]!([{ name: "newer", annotations: { readOnlyHint: true } }]);
  await newer;
  pending[0]!([{ name: "older", annotations: { readOnlyHint: true } }]);
  await older;

  assert.deepEqual(provider.tools.map((tool) => tool.name), ["newer"]);
});

test("MCPToolProvider close waits for an active callTool before closing the client", async () => {
  const events: string[] = [];
  let callStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    callStarted = resolve;
  });
  let finishCall!: () => void;
  const callResult = new Promise<unknown>((resolve) => {
    finishCall = () => {
      events.push("call:end");
      resolve({ content: [{ type: "text", text: "committed" }] });
    };
  });
  const provider = new MCPToolProvider({
    async listTools() {
      return [{ name: "commit", annotations: { readOnlyHint: true } }];
    },
    async callTool() {
      events.push("call:start");
      callStarted();
      return callResult;
    },
    async close() {
      events.push("client:close");
    },
  }, { trustToolAnnotations: true });
  const [tool] = await provider.load();
  const execution = tool!.execute({}, baseContext);
  await started;

  const closing = provider.close();
  assert.deepEqual(events, ["call:start"]);
  await assert.rejects(tool!.execute({}, baseContext), MCPToolProviderClosedError);
  finishCall();

  assert.deepEqual(await execution, {
    content: [{ type: "text", text: "committed" }],
  });
  await closing;
  assert.deepEqual(events, ["call:start", "call:end", "client:close"]);
});

test("MCPToolProvider close waits for an active refresh before closing the client", async () => {
  const events: string[] = [];
  let listCalls = 0;
  let refreshStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    refreshStarted = resolve;
  });
  let finishRefresh!: () => void;
  const refreshResult = new Promise<readonly [{ name: string }]>((resolve) => {
    finishRefresh = () => {
      events.push("list:end");
      resolve([{ name: "new" }]);
    };
  });
  const provider = new MCPToolProvider({
    async listTools() {
      listCalls += 1;
      if (listCalls === 1) return [{ name: "initial" }];
      events.push("list:start");
      refreshStarted();
      return refreshResult;
    },
    async callTool() {
      return "ok";
    },
    async close() {
      events.push("client:close");
    },
  });
  await provider.load();
  const refreshing = provider.refresh();
  await started;

  const refreshFailure = assert.rejects(refreshing, MCPToolProviderClosedError);
  const closing = provider.close();
  assert.deepEqual(events, ["list:start"]);
  await assert.rejects(provider.refresh(), MCPToolProviderClosedError);
  finishRefresh();

  await refreshFailure;
  await closing;
  assert.deepEqual(events, ["list:start", "list:end", "client:close"]);
});
