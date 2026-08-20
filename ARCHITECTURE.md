# 42 Agent Architecture

`AgentLoop` and its `SessionStore` are the only source of truth for conversation and run state.
Sessions are independent from channels: any channel may continue a session by resolving an inbound event
to the same session ID.

```text
channel/*  ───────────────┐
                          ▼
provider/* ────────► AgentLoop ◄──────── skills.ts
                          │
runtime/*  ◄──────────────┤
                          ▼
                       tools/* ◄──────── mcp.ts
                          │
                          ▼
                     SessionStore
```

## Boundaries

- `channel/`: Normalize frontend events, forward streaming events, and send final output. Never store history.
- `provider/`: Convert canonical messages to provider payloads and normalize provider responses.
- `runtime/`: Streaming, cancellation, steering, retry, tool execution, checkpoints, and recovery.
- `tools/`: Tool definitions and execution. Tools receive the current Session and AbortSignal.
- `skills.ts`: Load optional instructions. A Skill does not own tools, permissions, or sessions.
- `mcp.ts`: Convert MCP tools into the same Tool interface used by local tools.
- `session.ts`: Canonical messages and durable `RunState`/`ToolCallState`.
- `agent-loop.ts`: The only orchestrator allowed to mutate conversation and run state.

## Concurrency

Turns are serialized FIFO per session. Different sessions remain concurrent. Persistence implementations
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
