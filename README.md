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
- cancel active work and recover conservatively after an interrupted run

The runtime is deliberately a single-process building block. A production application may launch many
42 Agent processes and run them in parallel. Those agents remain independent: they do not share an
in-memory queue, do not coordinate through a common `SessionStore`, and do not require distributed locks.

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
above `AgentLoop`; protocol-specific lifecycle and message types must not leak into the core execution
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
channel B ─┼─► AgentLoop ─► Model / Tools ─► SessionStore
channel C ─┘
```

## Current capabilities

- protocol-neutral `AgentRuntime` lifecycle for sessions, prompts, cancellation, steering, and capabilities
- runtime, session, and turn-level Tool/Skill selection without injecting implementations through prompts
- canonical server-side messages and run state
- streaming model events and cancellation
- local and MCP-compatible tools
- steering at model/tool barriers
- durable checkpoints at model and tool boundaries
- conservative crash reconciliation: uncertain side effects are never replayed automatically
- in-memory, file, and SQLite session stores
- per-session FIFO execution while different sessions remain concurrent

## Architecture

`AgentLoop` is the orchestrator and `SessionStore` is the persistence boundary. Channels normalize
transport-specific input and forward events; providers normalize model APIs; tools execute capabilities.
See [ARCHITECTURE.md](./ARCHITECTURE.md) for boundaries and recovery semantics.

## Quick start

Requires Node.js 22.13 or newer (Node.js 25 is recommended for the built-in SQLite store).

```bash
npm install
npm test
npm run example
```

To run the OpenRouter-backed HTTP runtime:

```bash
export OPENROUTER_API_KEY=...
npm run runtime
```

Then use the CLI with an explicit session ID:

```bash
npm run cli -- --session shared-session
```

Another channel that resolves to `shared-session` will continue the same canonical session.

## Runtime guarantees

- Within one runtime process, turns for one session execute in FIFO order; different sessions may execute concurrently.
- Separate runtime processes are independent and may execute concurrently without sharing session state.
- Completed tool results are persisted before the next model step.
- A tool left in `running` state after a crash is treated as having an unknown outcome and is not replayed.
- The runtime does not claim exactly-once execution for external side effects.

## Repository layout

```text
src/agent-runtime.ts    protocol-neutral lifecycle and capability facade
src/agent-loop.ts       orchestration and session serialization
src/runtime/            model execution, retry, events, steering, tools
src/provider/           provider adapters
src/channel/            reusable channel adapters
src/tools/              local tools
src/session*.ts         session contracts and stores
apps/web/               deployable browser client
examples/               minimal and HTTP runtime examples
tests/                  runtime and integration tests
```

## Direction

Deployable clients live under `apps/`; reusable integrations remain under `src/channel/`. The next major
protocol milestone is an ACP adapter with explicit session lifecycle, structured updates, cancellation,
capability negotiation, and permission bridging. Checkpoint continuation for interrupted runs remains a
runtime milestone.
