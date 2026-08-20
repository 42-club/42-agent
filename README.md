# 42 Agent

42 Agent is a small, embeddable TypeScript runtime for durable, tool-using AI agents.

The central design rule is that **sessions are independent from channels**. Any channel can join and
continue the same session by resolving an inbound event to the same session ID. HTTP, web, CLI, and
bot integrations are examples of channels; none of them owns or reconstructs conversation history.

```text
channel A ─┐
channel B ─┼─► AgentLoop ─► Model / Tools ─► SessionStore
channel C ─┘
```

## Current capabilities

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

- Turns for one session execute in FIFO order; turns for different sessions may execute concurrently.
- Completed tool results are persisted before the next model step.
- A tool left in `running` state after a crash is treated as having an unknown outcome and is not replayed.
- The runtime does not claim exactly-once execution for external side effects.

## Repository layout

```text
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
milestone is checkpoint continuation for interrupted runs.
