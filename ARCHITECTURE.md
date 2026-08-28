# 42 Agent Architecture

`AgentRuntime` is the protocol-neutral host boundary. All protocol/channel turns pass through it for
session lifecycle, capability selection, cancellation, and close admission. It derives the canonical
`SessionStore`, `ToolRegistry`, and Skill loader from `AgentLoop`; supplying different instances is rejected at
construction. `AgentLoop`, its per-session coordinator, and that Store are the only source of truth for
conversation and run state.
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
- `runtime/`: Streaming, cooperative cancellation, steering, retry, bounded tool execution, checkpoints,
  and recovery.
- `tools/`: Tool definitions and execution. Tools receive an immutable Session snapshot and AbortSignal;
  only trusted tools registered with write access receive the live Session through `mutableSession`.
  Write tools execute as exclusive barriers. `sessionAccess` describes only Session mutation; external
  ordering is controlled separately by `executionPolicy`.
- `skills.ts`: Load optional instructions. A Skill does not own tools, permissions, or sessions.
- `mcp.ts`: Convert MCP tools into the same Tool interface used by local tools.
- `session.ts`: Canonical messages and durable `RunState`/`ToolCallState`.
- `agent-loop.ts`: The only core coordinator allowed to admit conversation and run-state mutations.
  Trusted write tools mutate only while executing inside its exclusive tool barrier.

Protocol adapters call `AgentRuntime`; they do not create alternative execution loops. Tool and Skill
implementations are registered by the embedding host. A session or turn may select registered capability
names, but protocol input never injects executable implementations. Runtime DTOs, Model requests, Tool
arguments, progress events, and session-read-only Tool contexts are detached from canonical state, so a
consumer cannot mutate the source of truth through a boundary object.

## Process model

One runtime process hosts one independent agent. Multiple processes may run concurrently under an
application-level orchestrator. They do not share in-memory queues or mutable sessions, and this project
does not provide cluster membership, distributed scheduling, or cross-agent collaboration policy. Each
process must have its own Store; cross-process sharing of one File or SQLite Store is unsupported.

ACP is the intended client-to-agent protocol boundary. ACP-specific JSON-RPC and wire types belong in a
future adapter above `AgentRuntime`, not in the canonical session, loop, provider, Tool, or Skill models.

## Concurrency

Turns and explicit recovery are serialized FIFO per session within one runtime process. Session close
gates new work, cooperatively cancels admitted turns, waits for them to settle, and only then deletes state.
Different sessions and independent runtime processes remain concurrent.
Cancellation is checked again after a request waits for its FIFO slot: work cancelled before admission does
not append a message or create a Run. Steering/cancellation admission closes before terminal observers run,
so late control calls cannot affect a later Turn. Repeated and abort-listener-reentrant close calls share one
joinable shutdown promise.

Within a tool batch, tools using the parallel execution policy use bounded concurrency. An exclusive tool
is a barrier relative to every other call in the batch; Session writers are always exclusive, while tools
such as Bash can request ordered external effects without receiving Session write access. Cancellation
stops dispatching pending calls, marks them interrupted, and joins every already-started call. A Tool that ignores its
`AbortSignal` can delay shutdown; the Runtime never abandons it or permits its checkpoint to arrive after
close. A write-access Tool checkpoints the complete message history, so edits to existing messages have
the same durable meaning in every Store.

Persistence implementations use versions or database transactions, but storage locking is not a
substitute for semantic ordering. `save` is update-only: it must fail if the Session was deleted or its
version changed. Without `rewriteMessages`, the persisted message prefix is immutable and only appends are
accepted. File writes use a per-session queue, unique temporary files, fixed-length lowercase Session-ID
digests with stored-ID verification, and atomic rename within the supported single-process model. Session
IDs must be non-empty, well-formed Unicode. SQLite stores an explicit current Run ID rather than inferring
it from wall-clock timestamps.

## Safe recovery

Each model/tool boundary is saved to `SessionStore`. Completed and failed tool outcomes are durable;
recovery materializes any missing model-visible tool messages from those outcomes. A tool that was
`running` during a crash has an unknown external outcome and is not automatically replayed. Recovery may
continue from a safe checkpoint, but the runtime does not promise exactly-once external side effects.

Tool outcomes are normalized to JSON before being marked completed. Invalid or non-serializable outcomes
become durable, model-visible failures instead of leaving an unpersistable completed checkpoint. Automatic
conversation compression runs only when its Tool is active and preserves complete assistant/tool batches.

## Event delivery

Progress events are detached, deeply frozen, non-blocking best-effort projections of canonical state.
Observer exceptions, mutation attempts, or unresolved Promises cannot leave a run in `running`, turn a
durable success into a failure, or change a Tool outcome. Tool completion is persisted before its completion
event is emitted. Adapters own ordered delivery and backpressure; the HTTP adapter uses a bounded queue.
Protocols that need reliable delivery must add acknowledgement or outbox semantics above the Runtime event
interface.

## Streaming retry rule

Non-streaming model calls use exponential retry. A stream is not transparently retried after it begins
emitting, because a frontend may already have rendered those deltas. Provider adapters may reconnect
internally before yielding the first event. An adapted client exposes `stream` only when its underlying
transport actually supports streaming, so non-streaming transports retain the Runtime retry policy.
The OpenRouter adapter requires its protocol-level `[DONE]` marker and treats premature EOF as failure.
