import assert from "node:assert/strict";
import test from "node:test";
import {
  estimateModelRequestTokens,
  estimateTokenUpperBound,
  estimateTokens,
  type ModelRequest,
} from "../src/index.js";

test("provider-neutral token estimation is conservative for CJK and emoji", () => {
  assert.equal(estimateTokens("abcdef"), 3);
  assert.equal(estimateTokens("中".repeat(30)), 30);
  assert.equal(estimateTokens("😀".repeat(10)), 20);
  assert.ok(estimateTokens("abc中文😀") >= 5);
});

test("hard-budget fallback uses a UTF-8 byte upper bound", () => {
  assert.equal(estimateTokenUpperBound("abcdef"), 6);
  assert.equal(estimateTokenUpperBound("中"), 3);
  assert.equal(estimateTokenUpperBound("😀"), 4);
  assert.equal(estimateTokenUpperBound("!@#$%^&*()_+"), 12);
});

test("fallback request estimation covers system prompts, schemas, and tool-call arguments", () => {
  const base: ModelRequest = {
    systemPrompt: "",
    messages: [{ role: "user", content: "go" }],
    tools: [],
  };
  const systemHeavy: ModelRequest = {
    ...base,
    systemPrompt: "规则".repeat(100),
  };
  const schemaHeavy: ModelRequest = {
    ...base,
    tools: [{
      name: "lookup",
      description: "description".repeat(30),
      inputSchema: {
        type: "object",
        properties: { query: { type: "string", description: "字段".repeat(50) } },
      },
    }],
  };
  const argumentsHeavy: ModelRequest = {
    ...base,
    messages: [{
      role: "assistant",
      content: "",
      metadata: {
        toolCalls: [{ id: "call-1", name: "lookup", arguments: { query: "参数".repeat(80) } }],
      },
    }],
  };

  const baseEstimate = estimateModelRequestTokens(base);
  assert.ok(estimateModelRequestTokens(systemHeavy) > baseEstimate);
  assert.ok(estimateModelRequestTokens(schemaHeavy) > baseEstimate);
  assert.ok(estimateModelRequestTokens(argumentsHeavy) > baseEstimate);

  const controller = new AbortController();
  assert.equal(
    estimateModelRequestTokens({ ...systemHeavy, signal: controller.signal }),
    estimateModelRequestTokens(systemHeavy),
  );
});

test("fallback request estimation ignores unsent metadata and tolerates non-JSON tool arguments", () => {
  const base: ModelRequest = {
    systemPrompt: "system",
    messages: [{ role: "user", content: "go" }],
    tools: [],
  };
  const circularMetadata: Record<string, unknown> = { auditId: 1n };
  circularMetadata.self = circularMetadata;
  const withUnsentMetadata: ModelRequest = {
    ...base,
    messages: [{
      role: "user",
      content: "go",
      createdAt: "2026-08-30T00:00:00.000Z",
      metadata: {
        uiState: "x".repeat(10_000),
        nonJson: circularMetadata,
      },
    }],
  };
  assert.equal(
    estimateModelRequestTokens(withUnsentMetadata),
    estimateModelRequestTokens(base),
  );

  const circularArguments: Record<string, unknown> = { amount: 1n };
  circularArguments.self = circularArguments;
  const assistantWithoutToolCall: ModelRequest = {
    ...base,
    messages: [{ role: "assistant", content: "" }],
  };
  const withToolCall: ModelRequest = {
    ...base,
    messages: [{
      role: "assistant",
      content: "",
      metadata: {
        ignored: circularMetadata,
        toolCalls: [{
          id: "call-1",
          name: "lookup",
          arguments: circularArguments,
        }],
      },
    }],
  };
  assert.doesNotThrow(() => estimateModelRequestTokens(withToolCall));
  assert.ok(
    estimateModelRequestTokens(withToolCall)
      > estimateModelRequestTokens(assistantWithoutToolCall),
  );
});
