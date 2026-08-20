import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BashPolicy, BashTool } from "../src/index.js";

test("denies delete operations", () => {
  const policy = new BashPolicy();
  assert.equal(policy.evaluate("rm -rf ./x").allowed, false);
  assert.equal(policy.evaluate("find . -delete").allowed, false);
  assert.equal(policy.evaluate("DELETE FROM users").allowed, false);
});

test("requires approval for irreversible operations", () => {
  const decision = new BashPolicy().evaluate("git reset --hard HEAD~1");
  assert.equal(decision.allowed, true);
  assert.equal(decision.requiresApproval, true);
});

test("executes a safe command", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-loop-"));
  const tool = new BashTool({ defaultCwd: cwd });
  const result = (await tool.execute(
    { command: "pwd" },
    {
      session: { id: "s", messages: [], metadata: {} },
      requestApproval: async () => true,
    },
  )) as { exitCode: number; executed: boolean };
  assert.equal(result.exitCode, 0);
  assert.equal(result.executed, true);
});
