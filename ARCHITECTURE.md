# 42 Agent Architecture

`AgentRuntime` is the protocol-neutral host boundary. All protocol/channel turns pass through it for
session lifecycle, capability selection, cancellation, and close admission. It derives the canonical
`SessionStore`, `ToolRegistry`, and Skill loader from `AgentLoop`; supplying different instances is rejected at
construction. A constructed Runtime is ready for use immediately, with `close()` as its terminal lifecycle
transition.
`AgentLoop`, its per-session coordinator, and that Store are the only source of truth for
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
                         ▲
runtime/* policy plans ─┘
                         │
                         ▼
                      ToolRegistry ◄──── mcp.ts
                         │
                         ▼
                    SessionStore
                         ▲
                         │
              storage/* config/lifecycle
```

## Boundaries

- `agent-runtime.ts`: Own explicit session lifecycle, active-run cancellation, steering, and capability
  selection. It contains no ACP, HTTP, CLI, or application-specific types.
- `acp/`: Adapt stable ACP v1 from the official SDK to `AgentRuntime`, project ordered bounded updates,
  and optionally bridge protocol permission requests to the Runtime's boolean approval hook.
- `channel/`: Normalize frontend events, forward streaming events, and send final output. Never store history.
- `provider/`: Convert canonical messages to provider payloads and normalize provider responses.
- `runtime/`: Streaming, cooperative cancellation, steering, retry, bounded tool execution, checkpoints,
  and recovery. `ModelRequestPlanner`, `RunRecovery`, and `RunFinalizer` inspect detached snapshots and
  return plans; they do not mutate a Session, save state, execute tools, or publish events.
- `storage/`: Select and open managed PostgreSQL, Supabase, or SQLite Stores, validate/migrate the private
  database schema, and own database-resource lifecycle. Supabase reuses the PostgreSQL engine through a
  database connection; it is not implemented through the Data API.
- `tools/`: Tool definitions and execution. Tools receive an immutable Session snapshot and AbortSignal;
  only trusted tools registered with write access receive the live Session through `mutableSession`.
  Write tools execute as exclusive barriers. `sessionAccess` describes only Session mutation; external
  ordering is controlled separately by `executionPolicy`.
- `skills.ts`: Load optional instructions. A Skill does not own tools, permissions, or sessions.
- `mcp.ts`: Convert MCP tools into the same Tool interface used by local tools, apply host-owned trust and
  ordering policy, normalize failures, and own refresh/close lifecycle when using `MCPToolProvider`.
- `legacy/`: Isolate deprecated compatibility APIs that can bypass current coordination invariants. It is
  never re-exported by the core or `runtime/` barrels.
- `session.ts`: Canonical messages and durable `RunState`/`ToolCallState`.
- `agent-loop.ts`: The only core coordinator allowed to admit conversation and run-state mutations. It
  applies policy plans and remains responsible for FIFO admission, live state, tool authorization,
  checkpoints, and event ordering. Trusted write tools mutate only while executing inside its exclusive
  tool barrier.

Protocol adapters call `AgentRuntime`; they do not create alternative execution loops. Tool and Skill
implementations are registered by the embedding host. A session or turn may select registered capability
names, but protocol input never injects executable implementations. Runtime DTOs, Model requests, Tool
arguments, progress events, and session-read-only Tool contexts are detached from canonical state, so a
consumer cannot mutate the source of truth through a boundary object.

## Process model

One runtime process hosts one independent agent. Multiple processes may run concurrently under an
application-level orchestrator. They do not share in-memory queues or mutable sessions, and this project
does not provide cluster membership, distributed scheduling, or cross-agent collaboration policy. A
physical PostgreSQL database may serve several processes only when the application provides disjoint
ownership: at most one process may own a given `(namespace, Session ID)` at a time. Database version checks
do not provide cross-process FIFO ordering or exactly-once tool effects. Cross-process sharing of one File
or SQLite file remains unsupported.

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
The adapter stores the root as a protected Runtime binding that generic metadata cannot forge. Resume,
prompt, cancel, and delete check that binding inside the same Runtime admission/close gate as the operation,
including a final re-check immediately before deletion. Existing Sessions with missing or foreign bindings
are rejected without disclosing their ownership; missing resume/prompt targets fail while delete remains
idempotent. Cancel targets only prompts admitted with the same binding, and protocol input never widens
Tool roots.

The protected value is an exact versioned envelope `{ version: 1, kind, value }` persisted through a
Store-protected top-level field and, for database Stores, an independent column. Trust comes from that
explicit Store capability and atomic write path, never from the envelope's shape in generic metadata.
Consequently every generic `runtime.binding` value and the former `acp.cwd` marker lack trustworthy
provenance; both are fail-closed quarantined and unbound protocol adapters project them as missing. Current
generic Session metadata strips both keys. A custom Store must implement protected atomic create and
one-time claim before bindings are enabled. A host may retain an origin/main-era ACP Session only through
the optional
`authorizeLegacySessionMigration` callback backed by a trusted Session-ID allowlist or external inventory;
matching `cwd` metadata alone must never authorize migration. Once approved, `AgentRuntime` re-reads and
validates the exact legacy marker within the Loop's per-Session FIFO, removes it, and performs a single
versioned save. Save outcome-unknown is propagated without retry so the host must reload before deciding
what happened. Pending authorization is an abortable adapter scope: delete/disconnect cancel and join it,
and delete closes new resume/prompt admission before waiting.

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

Turns and explicit recovery are serialized FIFO per session within one runtime process. Runtime reserves
that FIFO position before asynchronous Session lookup, binding checks, or Skill loading, so a later fast
request cannot overtake an earlier request or decide its initial capability scope. Session close
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
IDs must be non-empty, NUL-free, well-formed Unicode. SQLite stores an explicit current Run ID rather than
inferring it from wall-clock timestamps.

Protected Session ownership is outside generic metadata. Supporting Stores advertise the capability,
persist ownership atomically at create time or through a one-time versioned claim, and reject ordinary
saves that add, remove, or replace it. The File Store writes a magic-framed exact container atomically;
legacy raw Session JSON remains readable, but any top-level `ownership` in that old format is ignored.

## Database selection and lifecycle

Managed persistence exposes three configuration profiles backed by two engines:

```text
PostgreSQL profile ──────────┐
                              ├──► PostgreSQL SessionStore
Supabase database profile ────┘
SQLite profile ──────────────► SQLite SessionStore
```

Every declared profile must be complete and valid. `auto` selects the highest-priority declared profile in
the fixed order PostgreSQL, Supabase, SQLite. Selection is a startup configuration decision, not failover:
after a profile is selected, a readiness or connection failure fails startup and never falls through to
another Store. Runtime failure also never changes the canonical Store. Explicit `mode` selects only the
named profile. Resolution diagnostics omit credentials.

PostgreSQL and Supabase share one transactional Store and use `(namespace, Session ID)` as the durable
identity. Their tables live in the private `agent_runtime` schema, not `public`, and one checkpoint updates
Session version, messages, current Run, and tool calls in one transaction. A Supabase profile accepts a
PostgreSQL database URL (normally direct connection for a persistent backend, or session pooler when IPv4
requires it); it does not use `supabase-js`, the REST/GraphQL Data API, or a browser key.

If a Store loses the acknowledgement for a commit and cannot verify whether that checkpoint became
durable, it throws `SessionSaveOutcomeUnknownError` and leaves the live Session version unchanged.
`AgentLoop` propagates that error without attempting a terminal save from the stale object; the embedding
host must reload before retrying or reconciling the Run.

Opening a PostgreSQL-backed Store checks the schema by default. Applying DDL is explicit through the
migration API or a deployment step; migration credentials may be separate from runtime credentials.
Migrations are ordered, checksummed, transactionally applied under a database lock, and reject an unknown
future version or a changed applied migration. When migration and runtime roles differ, deployment also
grants the runtime role `USAGE` on the private schema, `SELECT` on migration history for readiness, and DML
on the four data tables; readiness verifies each of those privileges before admitting work. A Supabase
deployment invokes this explicit migration from its deployment
workflow; the runtime's migration history remains separate from Supabase's own migration table.

The embedding host owns a managed Store. It calls `readinessCheck()` during startup as needed, closes
`AgentRuntime` first so admitted work can drain, and only then calls `sessionStore.close()` to release the
PostgreSQL pool or SQLite resource. Runtime close does not close an injected Store implicitly.

## Loop policy plans

Three extracted policy objects reduce `AgentLoop` size without creating alternative coordinators:

- `ModelRequestPlanner` builds prompt/budget decisions and returns `ready`, `compress`, or `reject`. Provider
  capability I/O, token estimation, compression-tool execution, and compression checkpoints remain in the
  Loop.
- `RunRecovery` reconciles a detached crashed-run snapshot and returns a no-op or recovery patch. It never
  loads/saves a Store or replays a Tool.
- `RunFinalizer` produces completed, failed, or cancelled terminal state plus save options and the terminal
  event payload. It never checkpoints, publishes, or replaces the original error.

`AgentLoop` validates the expected Run, applies each plan to the live Session, checkpoints it, and only then
publishes the corresponding event. This preserves one mutation-admission path and keeps durable state ahead
of observer-visible terminal outcomes. For tool batches it creates a private per-Run `RunMutationGate` that
couples each admitted mutation to a serialized checkpoint. The internal coordinated executor receives this
narrow gate instead of `SessionStore`; policy objects never receive either one. The deprecated
`ToolExecutor` is available only through the explicit `42-agent/legacy` compatibility entry point. It is
not exported by the package root or the `runtime/` barrel and is not part of the Loop's mutation path.
Trusted write tools may still access the live Session only within their exclusive Loop-authorized barrier.

## Safe recovery

Each model/tool boundary is saved to `SessionStore`. Completed and failed tool outcomes are durable;
recovery materializes any missing model-visible tool messages from those outcomes. A tool that was
`running` during a crash has an unknown external outcome and is not automatically replayed. Recovery may
continue from a safe checkpoint, but the runtime does not promise exactly-once external side effects.

Tool outcomes are normalized to JSON before being marked completed. Invalid or non-serializable outcomes
become durable, model-visible failures instead of leaving an unpersistable completed checkpoint. Automatic
conversation compression runs only when its Tool is active and preserves complete assistant/tool batches.
Generated summaries are persisted as explicitly untrusted user-level data, never as system instructions;
legacy system-role summaries are demoted before the next model request and rewritten durably.

Before every model round, including rounds after tool results and steering, the Loop budgets the complete
provider request: system and Skill prompts, messages and tool-call arguments, and Tool schemas. Packaged
OpenRouter clients resolve the selected model's context window from OpenRouter model metadata and estimate
their serialized wire payload. Other `ModelClient` implementations must expose `capabilities`/
`getCapabilities`, or callers must configure `compressionThresholdTokens`, to enable token-based automatic
compression; the Loop deliberately has no invented default context window for an unknown model.

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

The package root is the protocol-neutral core. ACP, Channel, provider, storage, concrete Tool, MCP, and
legacy compatibility APIs are exposed only through explicit package subpaths. This keeps importing the
core from eagerly evaluating optional adapter dependency graphs and prevents internal Runtime policy
objects from becoming accidental compatibility commitments.
