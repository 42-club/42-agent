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

- `AgentLoop` is the sole orchestrator of a turn and the only core component that coordinates mutations
  to conversation and run state.
- `AgentRuntime` owns protocol-neutral session lifecycle, active-run control, and capability selection.
- `SessionStore` is the persistence boundary for canonical messages, run state, and tool-call state.
- A Channel or protocol adapter never owns, reconstructs, or silently forks conversation history.
- Provider payloads, transport messages, and UI state are not canonical session state.

Preserve a single canonical execution model. New transports and protocols should adapt to it instead of
creating parallel agent loops.

## ACP boundary

Agent Client Protocol (ACP) is the intended standard interface between each runtime process and its
client or application-level orchestrator. ACP support belongs in a dedicated adapter layer above
`AgentLoop`.

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
- `runtime/` owns execution mechanics such as retry, cancellation, steering, events, and tool execution.
- `tools/` owns capability definitions and execution, not scheduling or session lifecycle.
- `skills.ts` supplies optional instructions; skills do not own tools, permissions, sessions, or transports.
- `mcp.ts` adapts MCP tools to the local Tool interface. MCP supplies agent capabilities; ACP exposes and
  controls an agent from its client. Keep these responsibilities distinct.
- Product applications, generic chat UIs, authentication, tenancy, and hosting stacks belong to the
  production projects that embed this Runtime, not this repository.
- Add an application to this repository only when it has a focused Runtime-development responsibility,
  such as protocol inspection or conformance testing. Keep reusable runtime and protocol code under `src/`.

## Concurrency and durability

- Serialize turns FIFO per session within one runtime process.
- Allow different sessions and different runtime processes to execute concurrently.
- Save state at model/tool boundaries before advancing to the next unsafe step.
- Never automatically replay a tool whose external outcome is uncertain after interruption.
- Do not claim exactly-once external side effects without an explicit idempotency contract supplied by
  the tool or calling application.
- Persistence conflicts may be detected, but a Store must not silently redefine execution ordering.

## Change criteria

For changes to orchestration, sessions, tool execution, recovery, channels, or ACP adapters:

- state which architectural boundary owns the new behavior
- keep protocol-specific types out of the canonical domain model unless the concept is protocol-neutral
- test observable lifecycle behavior, not only helper functions
- preserve cancellation and checkpoint semantics
- update `README.md` and `ARCHITECTURE.md` when guarantees or responsibilities change

Prefer small adapters and explicit interfaces over a second orchestration path. If a requested feature
requires shared state or coordination between independent agent processes, implement it in the calling
application or document why the project boundary must change before adding it here.
