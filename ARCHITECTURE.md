# 42 Agent Architecture

`AgentRuntime` is the protocol-neutral host boundary. All protocol/channel turns pass through it for
session lifecycle, capability selection, cancellation, and close admission. It derives the canonical
`SessionStore`, `ToolRegistry`, and Skill loader from `AgentLoop`; supplying different instances is rejected at
construction. `AgentLoop`, its per-session coordinator, and that Store are the only source of truth for
conversation and run state.
The core Runtime does not bind Sessions to channels. A protocol adapter may still enforce admission and
ownership before resolving an inbound event to a Session ID; ACP, in particular, accepts only ACP-bound
Sessions in its configured workspace. Cross-channel continuation therefore requires an explicit trusted
migration rather than possession of an ID alone.

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
- `acp/`: Adapt stable ACP v1 from the official SDK to `AgentRuntime`, project ordered bounded updates,
  and optionally bridge protocol permission requests to the Runtime's boolean approval hook.
- `channel/`: Normalize frontend events, forward streaming events, and send final output. Never store history.
- `provider/`: Convert canonical messages to provider payloads and normalize provider responses.
- `runtime/`: Streaming, cooperative cancellation, steering, retry, bounded tool execution, checkpoints,
  and recovery.
- `tools/`: Tool definitions and execution. Tools receive an immutable Session snapshot and AbortSignal;
  only trusted tools registered with write access receive the live Session through `mutableSession`.
  Write tools execute as exclusive barriers. `sessionAccess` describes only Session mutation; external
  ordering is controlled separately by `executionPolicy`.
- `skills.ts`: Load optional instructions. A Skill does not own tools, permissions, or sessions.
- `mcp.ts`: Convert MCP tools into the same Tool interface used by local tools, apply host-owned trust and
  ordering policy, normalize failures, and own refresh/close lifecycle when using `MCPToolProvider`.
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

ACP is the implemented client-to-agent protocol boundary. ACP-specific JSON-RPC and wire types remain in
the adapter above `AgentRuntime`, not in canonical Session, Loop, Provider, Tool, or Skill models.

## ACP v1 adapter boundary

`createAcpAgent` builds a stable ACP v1 `AgentApp` using the official TypeScript SDK. It negotiates only
implemented capabilities and maps initialize, session new/resume/delete, prompt, and cancel to
`AgentRuntime`. It projects ordered text deltas and tool-call state, propagates request and session
cancellation, and can route approvals through `AcpPermissionBridge`. The embedding application owns the
transport and Runtime lifecycle; each `AgentApp` enforces one live ACP client connection at a time.

`workspaceRoot` is mandatory and is canonicalized with `realpath`. A session request's `cwd` must resolve
to that same host-enforced root; symlink aliases are accepted only when their canonical target matches.
The adapter records the root in Session metadata and verifies it on resume, prompt, and delete. Existing
Sessions with missing or foreign-root metadata are rejected without disclosing their ownership; missing
resume/prompt targets fail while delete remains idempotent. Cancel targets only prompts admitted by this
adapter, and protocol input never widens Tool roots.

Update projection has a bounded pending count and per-delivery timeout. Backpressure, timeout, transport
failure, request cancellation, session cancellation/deletion, and Runtime shutdown all terminate the
prompt scope without waiting forever on a client notification or permission request. ACP v1 cannot
replace an already streamed message; a divergent canonical final response is therefore sent under a new
message ID. `ToolRegistry` binds the canonical Turn signal to approval calls, so Runtime shutdown also
cancels a permission request awaited by an otherwise signal-unaware Tool.

The capability surface deliberately excludes session load/replay, `session/close`, additional workspace
directories, ACP-managed MCP server connections, and image/audio/embedded-resource
prompts. `resource_link` is preserved as an explicit text marker. Unsupported inputs are rejected at the
adapter boundary rather than ignored or injected into the Runtime.

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

MCP server annotations are descriptive hints, not authorization. Without an explicit
`trustToolAnnotations` host opt-in, every adapted MCP tool requires approval and uses exclusive execution.
Even with trusted annotations, non-read-only tools retain those safeguards. A wire-provided
`executionPolicy` cannot weaken ordering; only the local `executionPolicyFor` callback can override it.

`MCPToolProvider` gates new work during close, waits for every admitted `listTools` and `callTool` request
to settle, and only then closes the underlying client. Concurrent refreshes are generation-ordered so a
late older response cannot replace a newer snapshot. Cancellation is passed to listing, approval, and
execution. MCP `isError` results and JSON-RPC error envelopes become typed failures rather than durable
successes.

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

## Verification and distribution

The supported engine floor is Node.js 22.13; Node.js 24 LTS is recommended. CI verifies Node.js 22.13,
24, and 26 with lint, type-checking, tests, package inspection, and coverage gates of 85% lines/statements,
75% branches, and 80% functions across production output. Locally, `npm run check` composes lint,
type-checking, and the coverage-gated test run.

The package is licensed under Apache-2.0 and configured for public npm publication. Public releases use
semantic versions and require an explicit maintainer publish action; CI and `npm pack --dry-run` verify
the artifact without publishing it.
