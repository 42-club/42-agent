# 42 Agent

[中文文档](./README.zh-CN.md)

42 Agent is a small, embeddable TypeScript runtime for durable, tool-using AI agents. It is intended
to be the execution substrate beneath production applications, not the application-level agent
orchestrator itself.

## Project responsibility

One 42 Agent runtime hosts one independent agent process. It owns the execution and durable state of
the sessions assigned to that process:

- run the model/tool loop and expose structured progress events
- persist canonical messages, run state, and tool-call checkpoints
- enforce FIFO turn ordering within one session while allowing independent sessions to run concurrently
- normalize model providers, tools, skills, and frontend channels behind stable internal interfaces
- cooperatively cancel active work, join every started tool, and recover conservatively after interruption

The runtime is deliberately a single-process building block. A production application may launch many
42 Agent processes and run them in parallel. Those agents remain independent: they do not share an
in-memory queue, do not coordinate through a common `SessionStore`, and do not require distributed locks.
Give every process its own File/SQLite Store. Several processes may use one physical PostgreSQL database
only when the application keeps ownership disjoint; at most one process may own a given
`(namespace, session ID)` at a time.

The application above the runtime is responsible for agent discovery, task decomposition, scheduling,
result routing, collaboration policy, identity, tenancy, and deployment. If agent A's output becomes agent
B's input, that relationship is created by the application-level orchestrator rather than hidden inside
either agent runtime.

```text
production application / orchestrator
              │
              ├── ACP client ──► 42 Agent process A ──► SessionStore A
              ├── ACP client ──► 42 Agent process B ──► SessionStore B
              └── ACP client ──► 42 Agent process C ──► SessionStore C
```

## Protocol direction

[Agent Client Protocol (ACP)](https://agentclientprotocol.com/) is the standard boundary between an
application-level orchestrator and each 42 Agent process. The bundled adapter uses the official
`@agentclientprotocol/sdk` and implements stable ACP v1 over `AgentRuntime`; ACP-specific lifecycle and
wire types remain outside the core execution model. An orchestrator can act as the ACP client of several
independent agents and coordinate them concurrently.

ACP is a client-to-agent protocol in this architecture. It does not make the runtimes share state and is
not itself the collaboration policy: the orchestrator composes independent ACP connections into a
multi-agent system.

### ACP adapter

`createAcpAgent` exposes initialization, session new/resume/delete, prompt, cancellation, ordered text and
tool updates, and optional client-side permission requests. Prompt cancellation is forwarded from both
the request and `session/cancel`. Update delivery is ordered and bounded by `maxPendingUpdates` and
`updateDeliveryTimeoutMs`; a stalled client cancels the prompt rather than growing an unbounded queue.
Text and baseline `resource_link` prompt blocks are accepted, with resource links converted to explicit
text markers. `name`, `title`, and `version` configure the identity returned by initialization.

The required `workspaceRoot` is the canonical root already enforced by the host's tools or sandbox. ACP
session `cwd` must resolve to that same directory; this adapter does not dynamically reconfigure tool
roots. New ACP Sessions receive a protected Runtime binding to that root; generic Session metadata cannot
set or replace it. Resume, prompt, cancel, and delete atomically require the same binding, so a forged
metadata key or a delete/recreate race cannot cross adapter ownership. Missing or foreign bindings are
rejected without exposing whether an existing Session is foreign. Resume and prompt reject a nonexistent
Session, while delete remains idempotent. `session/cancel` affects only a prompt admitted by this adapter.

The binding is an exact versioned envelope (`{ version: 1, kind, value }`) persisted through a
Store-protected top-level field (and an independent column in database Stores). The trust boundary is that
protected Store capability and write path, not the JSON shape: every `runtime.binding` value in generic
metadata is quarantined rather than promoted. Sessions created by the previous ACP adapter carry only
`acp.cwd`; that key was also generic metadata and is insufficient proof of ownership. Both legacy forms are
hidden from unbound channels as missing Sessions, and current generic metadata strips both reserved keys.
The File Store likewise ignores `ownership` found in an older raw Session JSON file; only its new
magic-framed container carries protected provenance.
Custom Session Stores must explicitly implement the protected atomic create/claim contract before Runtime
bindings can be used. To retain a known pre-upgrade ACP Session, supply
`authorizeLegacySessionMigration` with a trusted Session-ID allowlist or equivalent external inventory.
Approval must not be based only on the stored `acp.cwd` or requested workspace. After approval, the Runtime
re-checks the exact marker inside the per-Session FIFO, removes it, and performs one versioned save. An
outcome-unknown save is returned to the host without retry; reload the Session to learn whether the binding
became durable. The callback receives an `AbortSignal`; delete and disconnect cancel and join pending
authorization, while delete blocks new resume/prompt admission for that Session.

To bridge Runtime approvals to the active ACP client, use the same `AcpPermissionBridge` when
constructing both `AgentLoop` and the adapter. The snippet assumes `model`, `tools`, and `sessionStore`
have been configured as in [`examples/minimal.ts`](./examples/minimal.ts):

```ts
import { Readable, Writable } from "node:stream";
import { ndJsonStream } from "@agentclientprotocol/sdk";
import { AgentLoop, AgentRuntime } from "42-agent";
import { AcpPermissionBridge, createAcpAgent } from "42-agent/acp";

const permissions = new AcpPermissionBridge();
const loop = new AgentLoop({
  model,
  tools,
  sessionStore,
  requestApproval: permissions.requestApproval,
});
const runtime = new AgentRuntime({ loop });

const app = createAcpAgent(runtime, {
  workspaceRoot: process.cwd(), // Must match the host tool/sandbox root.
  permissionBridge: permissions,
});
const connection = app.connect(ndJsonStream(
  Writable.toWeb(process.stdout),
  Readable.toWeb(process.stdin),
));
try {
  await connection.closed;
} finally {
  await runtime.close();
}
```

The embedding host owns the ACP transport; the example uses the official SDK's NDJSON stdio stream. The
adapter enforces one live ACP client connection per `AgentApp` instance.
Outside an active ACP prompt, `AcpPermissionBridge` denies by default unless the host supplies an explicit
fallback policy. `ToolRegistry` binds the canonical Turn signal to approval calls, so Runtime shutdown can
cancel a pending ACP permission request even when a Tool only awaits `requestApproval`.
The adapter deliberately reports `loadSession: false` and does not implement session replay/load,
`session/close`, additional workspace directories, ACP-managed MCP server lifecycles, or
image/audio/embedded-resource prompt blocks. Non-empty `mcpServers` and `additionalDirectories` are
rejected instead of being silently ignored. ACP v1 has no message-replacement primitive, so if a final
canonical response diverges from emitted deltas, it is published under a new message ID.

## Non-goals

42 Agent does not own:

- a distributed scheduler or cluster membership system
- shared mutable sessions across runtime processes
- cross-agent locking, consensus, or a global conversation history
- application-specific delegation, planning, or collaboration policy
- end-user authentication, tenant routing, billing, or product UI
- exactly-once execution of tools with external side effects

The central design rule is that **the core Runtime does not bind sessions to channels**. A concrete
adapter may still impose admission and ownership policy before resolving an event to a Session ID. HTTP,
web, CLI, and bot integrations are examples of channels; none reconstructs conversation history. The ACP
adapter operates only on ACP-bound Sessions in its configured workspace, so cross-channel continuation
requires an explicit trusted migration rather than possession of a Session ID alone.

```text
channel A ─┐
channel B ─┼─► AgentRuntime ─► AgentLoop ─► Model / Tools ─► SessionStore
channel C ─┘
```

## Current capabilities

- official stable ACP v1 adapter with honest capability negotiation, bounded updates, cancellation, and permission bridging
- protocol-neutral `AgentRuntime` lifecycle for sessions, prompts, cancellation, steering, and capabilities
- one canonical `SessionStore`, `ToolRegistry`, and Skill loader, derived from `AgentLoop` and checked at Runtime construction
- runtime, session, and turn-level Tool/Skill selection without injecting implementations through prompts
- protected protocol bindings plus immutable per-Turn Tool and Skill snapshots
- runtime-isolated, deeply immutable Session snapshots for read-only tools
- bounded parallel execution for explicitly parallel tools and exclusive execution for ordered side effects or trusted write tools
- canonical server-side messages and run state, isolated from Model, Tool-argument, event, and Runtime DTO snapshots
- detached, immutable, non-blocking progress events that cannot rewrite or stall canonical execution outcomes
- streaming model events and cooperative cancellation propagated to providers and MCP tools
- local and MCP-compatible tools
- steering at model/tool barriers
- durable checkpoints at model and tool boundaries
- conservative crash reconciliation: uncertain side effects are never replayed automatically
- update-only, version-checked in-memory, file, SQLite, and PostgreSQL session stores; Supabase reuses the
  PostgreSQL engine
- managed database startup selection with PostgreSQL > Supabase > SQLite priority and no failure fallback
- pure model-request, recovery, and finalization policy plans applied and checkpointed only by `AgentLoop`
- per-session FIFO turns and recovery while different sessions remain concurrent
- non-empty, NUL-free, well-formed Unicode Session IDs with collision-checked, fixed-length File Store paths

## Architecture

`AgentRuntime` is the only protocol-facing lifecycle facade. It derives the Store, Tool registry, and Skill
loader from `AgentLoop`, so validation, execution, close, and recovery cannot be wired to different sources
of truth.
`AgentLoop` owns the per-session FIFO coordinator and remains the only core mutation coordinator.
`ModelRequestPlanner`, `RunRecovery`, and `RunFinalizer` only return plans; the Loop applies them, saves the
result, and orders events. Its internal coordinated Tool executor receives only a private per-Run mutation
gate, which serializes admitted mutations with their checkpoints. The deprecated `ToolExecutor` retains
its old direct-construction API only from `42-agent/legacy`; it is not used by `AgentLoop` and is not part
of the stable core surface.
`SessionStore` is the persistence boundary.
Channels normalize transport input and project best-effort events; providers normalize model APIs; tools
execute capabilities. See
[ARCHITECTURE.md](./ARCHITECTURE.md) for boundaries, storage selection, and recovery semantics.

## Quick start

Requires Node.js 22.13 or newer. Node.js 24 LTS is recommended.

```bash
npm install
npm test
npm run example
```

Engineering checks are available separately or as one local gate:

```bash
npm run lint
npm run typecheck
npm run coverage
npm run check
```

`npm run coverage` runs the test suite and enforces at least 85% lines/statements, 75% branches, and 80%
functions across `dist/src`. GitHub Actions runs lint, type-checking, coverage gates, and
`npm pack --dry-run` on Node.js 22.13, 24, and 26.

The package root exports only the protocol-neutral core: `AgentLoop`, `AgentRuntime`, canonical model and
Session contracts, Skills, and `ToolRegistry`. Integrations use explicit public subpaths:

- `42-agent/acp`: ACP adapter
- `42-agent/channel`: Channel Runtime, HTTP server/client, and Channel contracts
- `42-agent/provider`: Provider adapters, including OpenRouter and AI SDK adapters
- `42-agent/storage`: File, SQLite, PostgreSQL/Supabase, and managed Store lifecycle
- `42-agent/tools`: Tool contracts, Bash, and conversation compression
- `42-agent/mcp`: MCP tool adaptation and lifecycle
- `42-agent/legacy`: deprecated `ToolExecutor` compatibility API only

Importing `42-agent` no longer evaluates ACP, provider, Channel, PostgreSQL, or other optional adapter
barrels. Imports of those symbols from the package root, including `ToolExecutor`, are breaking changes;
move them to the corresponding subpath. Internal `src/runtime/*` policy objects are not package exports.
This release also removes the no-op `AgentRuntime.start()` method: use a constructed Runtime immediately.
`RuntimeStopReason` is now only `"end_turn"`; cancellation and failure reject `prompt()` and must be handled
as errors (ACP maps cancellation to its own protocol stop reason). Finally, `SessionInfo.skills` and
`SessionInfo.tools` are now the explicit `CapabilityScope` union—branch on `mode` before reading `names`
instead of treating either field as an array.
It is licensed under [Apache-2.0](./LICENSE) and configured for public npm publication. Public releases
use semantic versions and remain an explicit maintainer action; `npm pack --dry-run` verifies package
contents without publishing them.

## Managed database storage

`openSessionStore` accepts PostgreSQL, Supabase, and SQLite configuration profiles backed by two physical
engines. In the default `auto` mode it selects PostgreSQL first, then Supabase, then SQLite:

```ts
import { resolve } from "node:path";
import {
  migratePostgresSchema,
  openSessionStore,
  resolveSessionDatabaseConfig,
  type SessionDatabaseConfig,
} from "42-agent/storage";

const storageConfig: SessionDatabaseConfig = {
  namespace: "orders-agent",
  ...(process.env.AGENT_POSTGRES_URL
    ? { postgres: { connectionString: process.env.AGENT_POSTGRES_URL } }
    : {}),
  ...(process.env.SUPABASE_DATABASE_URL
    ? {
        supabase: {
          databaseUrl: process.env.SUPABASE_DATABASE_URL,
          // Use only for an intentionally plaintext local/self-hosted database.
          ...(process.env.SUPABASE_DATABASE_SSL === "false" ? { ssl: false } : {}),
        },
      }
    : {}),
  sqlite: { filename: resolve(".agent-data/runtime.sqlite") },
};

// Safe to log: credentials are deliberately omitted.
console.log(resolveSessionDatabaseConfig(storageConfig));
const sessionStore = await openSessionStore(storageConfig);
```

Every declared profile is validated before selection, so a partial profile is a configuration error. Once
selected, connection or readiness failure fails startup; it never falls through to another profile, and
the Runtime never switches its canonical Store. Explicit `mode: "postgres" | "supabase" | "sqlite"`
selects only that profile. Adding a remote profile does not migrate existing SQLite data.

Supabase uses its PostgreSQL `databaseUrl`, not `supabase-js`, a Data API key, or the REST/GraphQL API. For
this persistent Node runtime, use a [direct database connection or the session pooler when IPv4 requires
it](https://supabase.com/docs/guides/database/connecting-to-postgres). PostgreSQL and Supabase data live in
the private `agent_runtime` schema and are keyed by `(namespace, session ID)`; the application must ensure
that no two processes own the same pair concurrently.

For each Supabase `databaseUrl` and `migrationUrl`, TLS defaults to `ssl: true` unless that URL contains an
option that actually configures SSL (`ssl`, `sslmode`, `sslcert`, `sslkey`, `sslrootcert`, or
`sslnegotiation=direct`). `sslnegotiation=postgres` changes only the handshake, so by itself it retains the
secure profile default. Empty, repeated, or unknown negotiation parameters are rejected rather than being
allowed to suppress TLS accidentally. When the URL configures SSL, the library leaves its effective value
to `pg`; an explicit profile-level `ssl` setting cannot be combined with those URL options. Set `ssl: false`
only for an intentionally plaintext local or self-hosted database; never disable TLS for hosted Supabase.
The safe resolution diagnostic includes `ssl` when the library selected it and omits the field when the URL
controls TLS.

PostgreSQL-backed startup defaults to `schemaMode: "check"`. Apply DDL explicitly in a deployment step
with `migratePostgresSchema(...)`, or opt a profile into `schemaMode: "migrate"`; an optional
`migrationConnectionString`/`migrationUrl` can keep elevated migration credentials separate from runtime
credentials. Put that explicit invocation in the deployment pipeline; Supabase documents its [database
migration workflow](https://supabase.com/docs/guides/deployment/database-migrations). `openSessionStore`
performs its readiness check before returning, including migration integrity and every documented runtime
schema/table privilege.

The standalone migration API is profile-aware, so Supabase retains the same secure TLS default:

```ts
await migratePostgresSchema({
  profile: "supabase",
  databaseUrl: process.env.SUPABASE_MIGRATION_URL
    ?? process.env.SUPABASE_DATABASE_URL!,
});

// A regular PostgreSQL deployment uses the connection string's TLS policy.
await migratePostgresSchema({
  profile: "postgres",
  connectionString: process.env.POSTGRES_MIGRATION_URL!,
});
```

If migration and runtime connections use different database roles, the deployment must also grant the
runtime role access to the private schema and data tables; the library does not infer or create that role.
For example, run the following as the schema owner after migrations, replacing `agent_runtime_user` with
the runtime role (and repeat grants when a later migration adds tables):

```sql
GRANT USAGE ON SCHEMA agent_runtime TO agent_runtime_user;
GRANT SELECT ON agent_runtime.schema_migrations TO agent_runtime_user;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON agent_runtime.sessions, agent_runtime.messages,
     agent_runtime.runs, agent_runtime.tool_calls
  TO agent_runtime_user;
```

The embedding host owns the managed Store. Close the Runtime first so admitted work finishes, then release
the Store's database resources:

```ts
await server.close();       // Stop request admission.
await runtime.close();      // Drain admitted work.
await sessionStore.close(); // Release the pool/database.
```

To run the OpenRouter-backed HTTP runtime:

```bash
export OPENROUTER_API_KEY=...
# Optional. PostgreSQL wins if both remote URLs are set.
export AGENT_POSTGRES_URL=postgresql://...
# Or: export SUPABASE_DATABASE_URL=postgresql://...
# For an explicit first migration: export AGENT_DATABASE_SCHEMA_MODE=migrate
npm run runtime
```

With neither remote URL set, the example uses the configured SQLite file. Its complete environment mapping
and signal-safe shutdown order are in [`examples/runtime-server.ts`](./examples/runtime-server.ts).

The HTTP server is a trusted development adapter, not a production ingress: it has no authentication,
binds to loopback by default, rejects browser origins unless an exact `allowedOrigin` is configured,
requires JSON request bodies, bounds request and queued event bytes, and does not register the optional
Bash tool. It returns typed 4xx admission failures, keeps internal failures generic, and redacts internal
error messages/codes from streamed events. Put authentication, Host/DNS-rebinding defense, tenancy, rate
limits, and deployment policy in the embedding application.

Then use the CLI with an explicit session ID:

```bash
npm run cli -- --session shared-session
```

Another channel that resolves to `shared-session` will continue the same canonical session.

## Runtime guarantees

- Within one runtime process, turns for one session execute in FIFO order; the slot is reserved before
  asynchronous Session/Skill preflight, while different sessions may execute concurrently.
- Explicit recovery uses the same per-session FIFO and cannot race an active turn.
- A request cancelled before its FIFO admission does not create a Run or append a user message.
- Steering and cancellation admission close at the Turn's terminal barrier; control messages cannot leak
  into the next Turn.
- Separate runtime processes are independent and may execute concurrently. They must not concurrently own
  the same namespaced Session even when their Stores use one physical PostgreSQL database.
- Cancellation stops new tool dispatch and does not settle until every already-started tool has settled.
- Repeated or re-entrant Runtime/Session close calls join the same shutdown operation; close gates new work,
  waits for admitted reads, recovery, Turns, and tools, then deletes Session state where requested.
- Completed tool results are persisted before the next model step.
- Recovery materializes every durable completed/failed tool outcome as a model-visible tool message.
- A tool left in `running` state after a crash is treated as having an unknown outcome and is not replayed.
- Store `save` operations update an existing version only; a late save cannot recreate a deleted session.
  Existing message prefixes are append-only unless `rewriteMessages` is explicit.
- A Store that cannot determine whether a save committed throws `SessionSaveOutcomeUnknownError`; the Loop
  does not attempt another save from the stale Session, and the host must reload before reconciliation.
- Event observers receive detached frozen values; exceptions, mutation attempts, and unresolved callbacks
  are isolated from canonical run and tool status. Adapters own ordered delivery and backpressure.
- The runtime does not claim exactly-once execution for external side effects.

## Tool trust and cancellation

Session-read-only tools receive a detached, deeply frozen Session snapshot. A tool registered with
`sessionAccess: "write"` is a trusted Runtime extension: it receives the live Session and runs as an
exclusive barrier relative to the rest of its tool batch. Tool results must be JSON-serializable; invalid
results become model-visible tool failures instead of corrupting persistence. Its checkpoint rewrites the
complete message history so mutations are durable consistently across Store implementations. Because this
is host-trusted code, it can intentionally change Session metadata, including Runtime-reserved capability
fields; subsequent queued authorization runs in FIFO order and observes the persisted change. It cannot
replace Store-protected ownership through a normal checkpoint: an attempted change fails the save instead
of changing adapter ownership.

`sessionAccess` says nothing about external side effects. Tools that must preserve external ordering use
`executionPolicy: "exclusive"`; only tools safe to overlap and reorder should use the default parallel
policy. Bash is exclusive. Tool-call arguments are detached before execution, and Model clients receive
frozen message/definition snapshots.

MCP annotations are untrusted hints by specification. Consequently, MCP tools require approval and run
exclusively by default, even when a server claims `readOnlyHint: true`. A host that trusts a configured
server may opt in with `trustToolAnnotations: true`; only then does an explicitly read-only tool skip
approval and default to parallel execution. Wire-provided `executionPolicy` values are ignored. Host-owned
ordering overrides belong in the local `executionPolicyFor` option:

```ts
const provider = new MCPToolProvider(client, {
  trustToolAnnotations: true, // Only for a server the host explicitly trusts.
  executionPolicyFor: ({ name }) => name === "ordered_read" ? "exclusive" : undefined,
});

const tools = await provider.load({ signal });
await provider.refresh({ signal });
await provider.close();
```

An MCP result with `isError: true` becomes a typed `MCPToolCallError` rather than a successful tool result;
JSON-RPC error envelopes become `MCPProtocolError`. `MCPToolProvider.close()` gates new execution and
refreshes, drains admitted `listTools`/`callTool` requests, and then closes the client, so an acknowledged
side effect is not discarded by premature transport shutdown. `loadMCPTools` remains a convenience for a
single snapshot when the caller owns the client lifecycle.

Cancellation is cooperative. Providers, MCP clients, and tools receive an `AbortSignal`, and the Runtime
waits for started work to settle. Implementations must observe that signal when prompt shutdown matters.
The optional `BashTool` requires explicit approval for every command, confines `cwd` by default, and bounds
captured output, but it is not a sandbox; production hosts should prefer an OS/container sandbox or a
strict command allowlist.

## Repository layout

```text
src/agent-runtime.ts    protocol-neutral lifecycle and capability facade
src/agent-loop.ts       orchestration and session serialization
src/runtime/            model execution, retry, events, steering, tools
src/provider/           provider adapters
src/acp/                official-SDK ACP v1 adapter, permission bridge, update projector
src/channel/            reusable channel adapters
src/tools/              local tools
src/mcp.ts              MCP tool policy, result normalization, refresh and lifecycle
src/storage/            managed database selection, migrations, and Store lifecycle
src/legacy/             explicitly isolated deprecated compatibility APIs
src/session*.ts         session contracts and stores
examples/               minimal and HTTP runtime examples
tests/                  runtime and integration tests
```

## Direction

This repository contains the reusable Runtime, protocol adapters, focused examples, and conformance or
integration tests. Product applications, deployment-specific UI, authentication, tenancy, and hosting
stacks belong in the production projects that embed this Runtime.

An application belongs in this repository only when it has a clear Runtime-development responsibility,
such as a future ACP protocol inspector. A generic chat UI or platform starter is not part of the Runtime.

The stable ACP v1 adapter now establishes the intended client-to-agent boundary. Future protocol work may
add session replay/load, more prompt content types, or ACP-managed MCP lifecycle only when their ownership
and recovery policies are explicit. Checkpoint continuation for interrupted runs remains a Runtime
milestone.
