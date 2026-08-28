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
Provision a distinct Store for each process; sharing one File or SQLite Store across runtimes is outside
the supported process model.

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

[Agent Client Protocol (ACP)](https://agentclientprotocol.com/) is the intended standard boundary
between an application-level orchestrator and each 42 Agent process. ACP should provide session
lifecycle, prompts, structured updates, cancellation, capability negotiation, and permission requests.
An orchestrator can act as the ACP client of several agents and coordinate them concurrently.

ACP support is a design target, not a current capability. The current HTTP and CLI channels demonstrate
the runtime boundary but are not substitutes for an ACP implementation. ACP belongs in an adapter layer
above `AgentRuntime`; protocol-specific lifecycle and message types must not leak into the core execution
model.

ACP is a client-to-agent protocol in this architecture. It does not make the runtimes share state and is
not itself the collaboration policy: the orchestrator composes independent ACP connections into a
multi-agent system.

## Non-goals

42 Agent does not own:

- a distributed scheduler or cluster membership system
- shared mutable sessions across runtime processes
- cross-agent locking, consensus, or a global conversation history
- application-specific delegation, planning, or collaboration policy
- end-user authentication, tenant routing, billing, or product UI
- exactly-once execution of tools with external side effects

The central design rule is that **sessions are independent from channels**. Any channel can join and
continue the same session by resolving an inbound event to the same session ID. HTTP, web, CLI, and
bot integrations are examples of channels; none of them owns or reconstructs conversation history.

```text
channel A ─┐
channel B ─┼─► AgentRuntime ─► AgentLoop ─► Model / Tools ─► SessionStore
channel C ─┘
```

## Current capabilities

- protocol-neutral `AgentRuntime` lifecycle for sessions, prompts, cancellation, steering, and capabilities
- one canonical `SessionStore`, `ToolRegistry`, and Skill loader, derived from `AgentLoop` and checked at Runtime construction
- runtime, session, and turn-level Tool/Skill selection without injecting implementations through prompts
- runtime-isolated, deeply immutable Session snapshots for read-only tools
- bounded parallel execution for explicitly parallel tools and exclusive execution for ordered side effects or trusted write tools
- canonical server-side messages and run state, isolated from Model, Tool-argument, event, and Runtime DTO snapshots
- detached, immutable, non-blocking progress events that cannot rewrite or stall canonical execution outcomes
- streaming model events and cooperative cancellation propagated to providers and MCP tools
- local and MCP-compatible tools
- steering at model/tool barriers
- durable checkpoints at model and tool boundaries
- conservative crash reconciliation: uncertain side effects are never replayed automatically
- update-only, version-checked in-memory, file, and SQLite session stores
- per-session FIFO turns and recovery while different sessions remain concurrent
- well-formed Unicode Session IDs with collision-checked, fixed-length File Store paths

## Architecture

`AgentRuntime` is the only protocol-facing lifecycle facade. It derives the Store, Tool registry, and Skill
loader from `AgentLoop`, so validation, execution, close, and recovery cannot be wired to different sources
of truth.
`AgentLoop` owns the per-session FIFO coordinator and `SessionStore` is the persistence boundary. Channels
normalize transport input and project best-effort events; providers normalize model APIs; tools execute
capabilities. See [ARCHITECTURE.md](./ARCHITECTURE.md) for boundaries and recovery semantics.

## Quick start

Requires Node.js 22.13 or newer (Node.js 25 is recommended for the built-in SQLite store).

```bash
npm install
npm test
npm run example
```

The private package metadata exposes `dist/src/index.js` and its declarations for workspace or tarball
consumption. `npm pack --dry-run` can be used as a local consumer check. A public registry release still
requires an explicit versioning and licensing decision by the project owner.

To run the OpenRouter-backed HTTP runtime:

```bash
export OPENROUTER_API_KEY=...
npm run runtime
```

The HTTP server is a trusted development adapter, not a production ingress: it has no authentication,
binds to loopback by default, rejects browser origins unless an exact `allowedOrigin` is configured,
requires JSON request bodies, bounds request and queued event bytes, and does not register the optional
Bash tool. Put authentication, Host/DNS-rebinding defense, tenancy, rate limits, and deployment policy in
the embedding application.

Then use the CLI with an explicit session ID:

```bash
npm run cli -- --session shared-session
```

Another channel that resolves to `shared-session` will continue the same canonical session.

## Runtime guarantees

- Within one runtime process, turns for one session execute in FIFO order; different sessions may execute concurrently.
- Explicit recovery uses the same per-session FIFO and cannot race an active turn.
- A request cancelled before its FIFO admission does not create a Run or append a user message.
- Steering and cancellation admission close at the Turn's terminal barrier; control messages cannot leak
  into the next Turn.
- Separate runtime processes are independent and may execute concurrently without sharing session state.
- Cancellation stops new tool dispatch and does not settle until every already-started tool has settled.
- Repeated or re-entrant Runtime/Session close calls join the same shutdown operation; close gates new work,
  waits for admitted reads, recovery, Turns, and tools, then deletes Session state where requested.
- Completed tool results are persisted before the next model step.
- Recovery materializes every durable completed/failed tool outcome as a model-visible tool message.
- A tool left in `running` state after a crash is treated as having an unknown outcome and is not replayed.
- Store `save` operations update an existing version only; a late save cannot recreate a deleted session.
  Existing message prefixes are append-only unless `rewriteMessages` is explicit.
- Event observers receive detached frozen values; exceptions, mutation attempts, and unresolved callbacks
  are isolated from canonical run and tool status. Adapters own ordered delivery and backpressure.
- The runtime does not claim exactly-once execution for external side effects.

## Tool trust and cancellation

Session-read-only tools receive a detached, deeply frozen Session snapshot. A tool registered with
`sessionAccess: "write"` is a trusted Runtime extension: it receives the live Session and runs as an
exclusive barrier relative to the rest of its tool batch. Tool results must be JSON-serializable; invalid
results become model-visible tool failures instead of corrupting persistence. Its checkpoint rewrites the
complete message history so mutations are durable consistently across Store implementations.

`sessionAccess` says nothing about external side effects. Tools that must preserve external ordering use
`executionPolicy: "exclusive"`; only tools safe to overlap and reorder should use the default parallel
policy. Bash is exclusive, and MCP tools default to exclusive unless explicitly marked parallel. Tool-call
arguments are detached before execution, and Model clients receive frozen message/definition snapshots.

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
src/channel/            reusable channel adapters
src/tools/              local tools
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

The next major protocol milestone is an ACP adapter with explicit session lifecycle, structured updates,
cancellation, capability negotiation, and permission bridging. Checkpoint continuation for interrupted
runs remains a runtime milestone.
