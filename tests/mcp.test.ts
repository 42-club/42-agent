import assert from "node:assert/strict";
import test from "node:test";
import { loadMCPTools } from "../src/index.js";

test("MCP tools propagate the runtime cancellation signal", async () => {
  let receivedSignal: AbortSignal | undefined;
  const [tool] = await loadMCPTools({
    async listTools() {
      return [{ name: "remote", inputSchema: { type: "object" } }];
    },
    async callTool(_name, _arguments, options) {
      receivedSignal = options?.signal;
      return "ok";
    },
  });
  const controller = new AbortController();

  await tool!.execute({}, {
    session: { id: "mcp", messages: [], metadata: {} },
    requestApproval: async () => false,
    signal: controller.signal,
  });

  assert.equal(receivedSignal, controller.signal);
});
