import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, realpath, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BashPolicy, BashTool } from "../src/index.js";

test("denies delete operations", () => {
  const policy = new BashPolicy();
  assert.equal(policy.evaluate("rm -rf ./x").allowed, false);
  assert.equal(policy.evaluate("/bin/rm -rf ./x").allowed, false);
  assert.equal(policy.evaluate("printf ok\nrm -rf ./x").allowed, false);
  assert.equal(policy.evaluate("find . -delete").allowed, false);
  assert.equal(policy.evaluate("DELETE FROM users").allowed, false);
});

test("requires approval for irreversible operations", () => {
  const decision = new BashPolicy().evaluate("git reset --hard HEAD~1");
  assert.equal(decision.allowed, true);
  assert.equal(decision.requiresApproval, true);
});

test("requires approval even when a mutation is hidden behind an interpreter", () => {
  const decision = new BashPolicy().evaluate("python3 -c 'import os; os.unlink(\"x\")'");
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

test("does not execute any command when approval is denied", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-loop-denied-"));
  const result = await new BashTool({ defaultCwd: cwd }).execute(
    { command: "pwd" },
    {
      session: { id: "s", messages: [], metadata: {} },
      requestApproval: async () => false,
    },
  ) as { executed: boolean };
  assert.equal(result.executed, false);
});

test("confines cwd and bounds captured output", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-loop-bounds-"));
  const tool = new BashTool({ defaultCwd: cwd, maxOutputBytes: 8 });
  const context = {
    session: { id: "s", messages: [], metadata: {} },
    requestApproval: async () => true,
  };

  await assert.rejects(
    tool.execute({ command: "pwd", cwd: ".." }, context),
    /escapes the configured default directory/,
  );
  await assert.rejects(
    tool.execute({ command: "printf 123456789" }, context),
    /output exceeded 8 bytes/,
  );
});

test("rejects cwd symlinks that escape the default directory", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-loop-symlink-root-"));
  const outside = await mkdtemp(join(tmpdir(), "agent-loop-symlink-outside-"));
  await symlink(outside, join(cwd, "escape"), "dir");
  let approvalRequests = 0;

  await assert.rejects(
    new BashTool({ defaultCwd: cwd }).execute(
      { command: "pwd", cwd: "escape" },
      {
        session: { id: "s", messages: [], metadata: {} },
        requestApproval: async () => {
          approvalRequests += 1;
          return true;
        },
      },
    ),
    /escapes the configured default directory/,
  );
  assert.equal(approvalRequests, 0);
});

test("shows the resolved cwd in the approval prompt", async () => {
  const actualCwd = await mkdtemp(join(tmpdir(), "agent-loop-real-cwd-"));
  const aliasParent = await mkdtemp(join(tmpdir(), "agent-loop-cwd-alias-"));
  const cwdAlias = join(aliasParent, "workspace");
  await symlink(actualCwd, cwdAlias, "dir");
  let approvalPrompt = "";

  const result = await new BashTool({ defaultCwd: cwdAlias }).execute(
    { command: "pwd" },
    {
      session: { id: "s", messages: [], metadata: {} },
      requestApproval: async (prompt) => {
        approvalPrompt = prompt;
        return false;
      },
    },
  ) as { executed: boolean };

  assert.equal(result.executed, false);
  assert.equal(approvalPrompt.includes(await realpath(actualCwd)), true);
});

test("aborts while waiting for a hanging approval request", { timeout: 2_000 }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-loop-hanging-approval-"));
  const controller = new AbortController();
  let markApprovalRequested: (() => void) | undefined;
  const approvalRequested = new Promise<void>((resolve) => {
    markApprovalRequested = resolve;
  });
  const execution = new BashTool({ defaultCwd: cwd }).execute(
    { command: "pwd" },
    {
      session: { id: "s", messages: [], metadata: {} },
      requestApproval: async () => {
        markApprovalRequested?.();
        return new Promise<boolean>(() => undefined);
      },
      signal: controller.signal,
    },
  );

  await approvalRequested;
  controller.abort(new DOMException("cancelled", "AbortError"));
  await assert.rejects(execution, (error: unknown) => (
    error instanceof DOMException && error.name === "AbortError"
  ));
});
