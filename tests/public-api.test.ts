import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the package root exposes core APIs without adapter or internal policy barrels", async () => {
  const core: Record<string, unknown> = await import("../src/index.js");

  assert.equal(typeof core.AgentLoop, "function");
  assert.equal(typeof core.AgentRuntime, "function");
  assert.equal(typeof core.ToolRegistry, "function");
  for (const excluded of [
    "AcpPermissionBridge",
    "BashTool",
    "ChannelRuntime",
    "ConversationCompressionTool",
    "ModelRequestPlanner",
    "OpenRouterModelClient",
    "PostgresSessionStore",
    "RetryPolicy",
    "ToolExecutor",
  ]) {
    assert.equal(excluded in core, false, `${excluded} leaked from the package root`);
  }
});

test("adapter and compatibility APIs have explicit public barrels", async () => {
  const [acp, channel, legacy, mcp, provider, runtime, storage, tools] = await Promise.all([
    import("../src/acp/index.js"),
    import("../src/channel/index.js"),
    import("../src/legacy/index.js"),
    import("../src/mcp.js"),
    import("../src/provider/index.js"),
    import("../src/runtime/index.js"),
    import("../src/storage/index.js"),
    import("../src/tools/index.js"),
  ]);

  assert.equal(typeof acp.createAcpAgent, "function");
  assert.equal(typeof channel.createAgentRuntimeHttpServer, "function");
  assert.equal(typeof legacy.ToolExecutor, "function");
  assert.equal(typeof mcp.MCPToolProvider, "function");
  assert.equal(typeof provider.OpenRouterModelClient, "function");
  assert.equal(typeof storage.FileSessionStore, "function");
  assert.equal(typeof storage.SqliteSessionStore, "function");
  assert.equal(typeof tools.BashTool, "function");
  assert.equal("ToolExecutor" in runtime, false);
});

test("package exports map every supported consumer entry point to declarations and ESM", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
    exports: Record<string, string | { types: string; import: string }>;
  };
  const publicSubpaths = [".", "./acp", "./channel", "./legacy", "./mcp", "./provider", "./storage", "./tools"];

  for (const subpath of publicSubpaths) {
    const target = packageJson.exports[subpath];
    assert.equal(typeof target, "object", `missing structured export for ${subpath}`);
    assert.match((target as { types: string }).types, /^\.\/dist\/src\/.+\.d\.ts$/);
    assert.match((target as { import: string }).import, /^\.\/dist\/src\/.+\.js$/);
  }
});
