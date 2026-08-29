# 42 Agent Development Contract

This file records the architectural constraints that contributors and coding agents must preserve.
`README.md` describes the product boundary; this file turns that boundary into implementation rules.

## Product model

42 Agent is a single-process execution runtime for one independent agent. It is a reusable substrate for
production applications that may start and coordinate many such processes concurrently.

Do not turn this repository into the application-level multi-agent orchestrator. Agent discovery,
scheduling, delegation, collaboration policy, result routing, tenancy, and deployment belong to the
calling application.

Multiple runtime processes are expected to be independent. Do not introduce shared-session semantics,
distributed locks, cluster membership, leader election, or cross-process FIFO ordering unless the
project's responsibility is explicitly changed. The per-session FIFO guarantee applies within one
runtime process.

## Sources of truth

- `AgentLoop` owns the per-session FIFO coordinator for turns and recovery and is the only core component
  that admits mutations to conversation and run state. `ModelRequestPlanner`, `RunRecovery`, and
  `RunFinalizer` are policy objects: they inspect detached snapshots and return decisions or mutation plans;
  they never own a Store, live Session, Tool execution, checkpoint, or Event delivery. `AgentLoop` privately
  creates a per-Run `RunMutationGate`; its internal coordinated executor receives only that gate, not the
  Store, so parallel workers serialize each admitted mutation with its checkpoint. The deprecated exported
  `ToolExecutor` direct-construction facade exists only for API compatibility and must not be used by core
  orchestration.
- `AgentRuntime` owns protocol-neutral session lifecycle, active-run control, and capability selection.
- `SessionStore` is the persistence boundary for canonical messages, run state, and tool-call state.
- `AgentRuntime` derives its Store, Tool registry, and Skill loader from `AgentLoop`. Never add a second
  independently configurable copy; mismatched sources of truth must fail at construction.
- A Channel or protocol adapter never owns, reconstructs, or silently forks conversation history.
- Provider payloads, transport messages, and UI state are not canonical session state.
- Runtime DTOs, Model requests, Tool arguments, progress events, and session-read-only Tool contexts must
  be detached from canonical state. Reserved capability metadata cannot be supplied or mutated through
  generic metadata. Protocol ownership belongs in a protected Runtime binding and must be checked atomically
  with admission, control, recovery, and deletion rather than in a preceding adapter read.

Preserve a single canonical execution model. New transports and protocols should adapt to it instead of
creating parallel agent loops.

## ACP boundary

Agent Client Protocol (ACP) is the intended standard interface between each runtime process and its
client or application-level orchestrator. ACP support belongs in a dedicated adapter layer above
`AgentRuntime`.

The adapter may translate:

- ACP initialization and capability negotiation into runtime capability descriptions
- ACP session lifecycle into explicit runtime session operations
- ACP prompts into canonical runtime input
- runtime events into structured ACP session updates
- ACP cancellation into the active turn's `AbortController`
- runtime approval requests into ACP permission requests

Do not place JSON-RPC envelopes, ACP wire types, or transport lifecycle branches inside `AgentLoop`,
tools, providers, or stores. Do not describe ACP as an agent-to-agent shared-state mechanism. An
orchestrator coordinates multiple agents by acting as a client to their independent ACP connections.

ACP is not implemented merely because an HTTP endpoint streams events. Claims of ACP support require
protocol-level conformance tests for the supported version and capabilities.

## Boundary rules

- `channel/` and future protocol adapters normalize input and project output; they do not persist history.
- `provider/` owns provider-specific request, response, and streaming formats.
- `runtime/` owns execution mechanics such as retry, cancellation, steering, event projection, and tool
  scheduling. Planning helpers under this boundary remain side-effect-free with respect to canonical state;
  `AgentLoop` applies their plans and preserves mutation/checkpoint/event ordering.
- `storage/` owns managed database configuration, startup selection, PostgreSQL/Supabase schema management,
  and managed Store lifecycle. Supabase is a PostgreSQL profile, not a separate Data API Store engine.
- `tools/` owns capability definitions and execution, not scheduling or session lifecycle. Session-read-only
  tools receive detached frozen Session snapshots. A write-access tool is trusted and always exclusive.
  External side-effect ordering is separate: use `executionPolicy: "exclusive"` without granting Session
  mutation; only overlap tools that are explicitly safe to reorder. Tool scheduling may request a checkpoint
  only through the private mutation gate supplied by `AgentLoop`; it must not regain direct Store access.
- Resolve Tool membership/definitions/policy and Skill instructions into immutable per-Turn snapshots.
  Registry refreshes affect later Turns only, and Runtime validation must not load a Skill again during
  Loop execution.
- `skills.ts` supplies optional instructions; skills do not own tools, permissions, sessions, or transports.
- `mcp.ts` adapts MCP tools to the local Tool interface. MCP supplies agent capabilities; ACP exposes and
  controls an agent from its client. Keep these responsibilities distinct.
- Product applications, generic chat UIs, authentication, tenancy, and hosting stacks belong to the
  production projects that embed this Runtime, not this repository.
- Add an application to this repository only when it has a focused Runtime-development responsibility,
  such as protocol inspection or conformance testing. Keep reusable runtime and protocol code under `src/`.

## Concurrency and durability

- Serialize turns and explicit recovery through the same FIFO per session within one runtime process.
- Reserve FIFO position before asynchronous Session, ownership, or capability preflight; authorization for
  a queued operation must observe all preceding Turn mutations inside that same serialized position.
- Allow different sessions and different runtime processes to execute concurrently.
- Session close must gate new work, cancel admitted work, join every started operation, and only then
  delete state. Global and per-Session close must publish one shared promise before triggering abort
  listeners, so repeated and synchronously re-entrant calls join the same shutdown. Do not let fail-fast
  aggregation leave orphan workers behind.
- Re-check cancellation after per-Session FIFO waiting and before mutating Session state. A pre-admission
  cancellation must not append a user message or create a Run. Close steering/cancel admission before
  terminal observers run, and scope steering to one Run so it cannot leak into the next Turn.
- Stop dispatching pending Tool calls after cancellation, mark them interrupted, and wait for every
  already-started Tool to settle. Parallel-policy calls use bounded concurrency; exclusive calls are barriers.
- Save state at model/tool boundaries before advancing to the next unsafe step.
- Persist a Tool outcome before publishing its completion event. Normalize results to JSON before marking
  them completed; serialization failures become model-visible Tool failures.
- A write-access Tool checkpoint rewrites the complete message history so edits and compression have the
  same durable meaning in every Store implementation.
- Never automatically replay a tool whose external outcome is uncertain after interruption.
- Do not claim exactly-once external side effects without an explicit idempotency contract supplied by
  the tool or calling application.
- `SessionStore.save` is update-only and version-checked. It must not recreate a deleted Session or accept
  a stale version. Its default message contract is append-only; modifying or shortening the persisted prefix
  requires `rewriteMessages`. File Store writes require a per-session queue, unique temporary files, atomic
  rename, and fixed-length lowercase Session-ID paths with stored-ID verification on every read/delete.
  Reject empty or ill-formed Unicode Session IDs at every Store and Runtime admission boundary.
- Managed database selection is a startup-only decision. In `auto` mode the priority is PostgreSQL, then
  Supabase, then SQLite. Every declared profile must be complete and valid. Once a profile is selected,
  readiness or connection failure must fail startup; never fall through to a lower-priority Store or switch
  Stores while running.
- PostgreSQL and Supabase use the same PostgreSQL Store implementation and the private `agent_runtime`
  schema. Supabase configuration accepts a database URL, not a Data API URL/key. Keep schema migration
  privileged access separate from runtime DML access; production startup checks schema compatibility by
  default, while DDL is an explicit migration/deployment action. If migration and runtime roles differ,
  deployment must provision the runtime role's private-schema usage and table permissions explicitly.
- A database namespace is part of persisted PostgreSQL identity. At most one Runtime process may own a
  given `(namespace, Session ID)` at a time; version checks are not cross-process FIFO or external-side-effect
  locks. A physical PostgreSQL database may host disjoint ownership domains, but sharing one File/SQLite
  file across Runtime processes remains unsupported.
- A managed Store is created and owned by the embedding host. Close the Runtime first so admitted work can
  finish, then close the Store and its database resources. `AgentRuntime.close()` must not silently close an
  injected Store it does not own.

## Cancellation and event delivery

- Cancellation is cooperative. Propagate `AbortSignal` through providers, MCP clients, compression, and
  local tools. The Runtime waits for started work; implementations that ignore the signal may delay close.
- Events are detached, deeply frozen, non-blocking best-effort projections, not transaction participants.
  An exception, mutation attempt, or unresolved observer Promise must never change or stall canonical state.
  Each adapter owns ordered delivery and backpressure; bound any transport queue.
- Do not transparently retry a model stream after it emits. Provider adapters must expose `stream` only
  when the underlying transport supports it so non-streaming calls keep the RetryPolicy.

## Tool and adapter safety

- Do not treat shell-command regular expressions as a security boundary. `BashTool` requires explicit
  approval for every command, resolves real paths, makes approval cancellation-aware, bounds output, runs
  exclusively, and remains an optional non-sandboxed capability.
- The example HTTP server is a trusted development adapter. Keep loopback binding, bounded request bodies,
  bounded event queues, exact Origin validation, and JSON-only writes; authentication, Host validation, and
  tenancy belong to the embedding app.
- Conversation compression is optional, runs only when selected, propagates cancellation, and must retain
  complete assistant/tool batches. Empty summaries fail without mutation; write checkpoints rewrite history.
- File-backed Skill loading must validate real paths so a symlink cannot escape its configured root.
  The loadable directory name is the capability name; frontmatter `name`, when present, must match it.
- MCP is a Tool capability protocol; ACP is the client-to-agent control protocol. Keep their lifecycle and
  wire types separate.

## Change criteria

For changes to orchestration, sessions, tool execution, recovery, channels, or ACP adapters:

- state which architectural boundary owns the new behavior
- keep protocol-specific types out of the canonical domain model unless the concept is protocol-neutral
- test observable lifecycle behavior, not only helper functions
- preserve cancellation, join, version, observer-isolation, and checkpoint semantics
- add fault-injection tests for races, cancellation, observer failure, stale writes, and adapter boundaries
- update `README.md` and `ARCHITECTURE.md` when guarantees or responsibilities change
- keep the package entry point, declarations, Node engine, and `npm pack` consumer surface working

Prefer small adapters and explicit interfaces over a second orchestration path. If a requested feature
requires shared state or coordination between independent agent processes, implement it in the calling
application or document why the project boundary must change before adding it here.
