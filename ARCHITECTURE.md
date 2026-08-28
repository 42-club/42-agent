# 42 Agent Architecture

`AgentRuntime` is the protocol-neutral host boundary. `AgentLoop` and its `SessionStore` are the only
source of truth for conversation and run state.
Sessions are independent from channels: any channel may continue a session by resolving an inbound event
to the same session ID.

```text
ACP / channel/* ──► AgentRuntime
                         │
                         ▼
provider/* ────────► AgentLoop ◄──────── SkillCatalog
                         │
runtime/*  ◄─────────────┤
                         ▼
                      ToolRegistry ◄──── mcp.ts
                         │
                         ▼
                    SessionStore
```

## Boundaries

- `agent-runtime.ts`: Own explicit session lifecycle, active-run cancellation, steering, and capability
  selection. It contains no ACP, HTTP, CLI, or application-specific types.
- `channel/`: Normalize frontend events, forward streaming events, and send final output. Never store history.
- `provider/`: Convert canonical messages to provider payloads and normalize provider responses.
- `runtime/`: Streaming, cancellation, steering, retry, tool execution, checkpoints, and recovery.
- `tools/`: Tool definitions and execution. Tools receive the current Session and AbortSignal.
- `skills.ts`: Load optional instructions. A Skill does not own tools, permissions, or sessions.
- `mcp.ts`: Convert MCP tools into the same Tool interface used by local tools.
- `session.ts`: Canonical messages and durable `RunState`/`ToolCallState`.
- `agent-loop.ts`: The only orchestrator allowed to mutate conversation and run state.

Protocol adapters call `AgentRuntime`; they do not create alternative execution loops. Tool and Skill
implementations are registered by the embedding host. A session or turn may select registered capability
names, but protocol input never injects executable implementations.

## Process model

One runtime process hosts one independent agent. Multiple processes may run concurrently under an
application-level orchestrator. They do not share in-memory queues or mutable sessions, and this project
does not provide cluster membership, distributed scheduling, or cross-agent collaboration policy.

ACP is the intended client-to-agent protocol boundary. ACP-specific JSON-RPC and wire types belong in a
future adapter above `AgentRuntime`, not in the canonical session, loop, provider, Tool, or Skill models.

## Concurrency

Turns are serialized FIFO per session within one runtime process. Different sessions and independent
runtime processes remain concurrent. Persistence implementations
may additionally use optimistic versions or database transactions, but storage locking is not a substitute
for semantic turn ordering.

## Safe recovery

Each model/tool boundary is saved to `SessionStore`. Completed tool results are durable. A tool that was
`running` during a crash has an unknown external outcome and is not automatically replayed. Recovery may
continue from a safe checkpoint, but the runtime does not promise exactly-once external side effects.

## Streaming retry rule

Non-streaming model calls use exponential retry. A stream is not transparently retried after it begins
emitting, because a frontend may already have rendered those deltas. Provider adapters may reconnect
internally before yielding the first event.
