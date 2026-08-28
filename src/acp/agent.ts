import { realpathSync, statSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import {
  agent,
  methods,
  PROTOCOL_VERSION,
  RequestError,
  type AgentConnection,
  type AgentApp,
  type ContentBlock,
  type Implementation,
  type NewSessionRequest,
  type ResumeSessionRequest,
} from "@agentclientprotocol/sdk";
import {
  AgentRuntime,
  RuntimeClosedError,
  SessionClosingError,
  SessionNotFoundError,
} from "../agent-runtime.js";
import { AcpPermissionBridge } from "./permission.js";
import { AcpUpdateProjector } from "./projector.js";

const ACP_CWD_METADATA = "acp.cwd";
const DEFAULT_MAX_PENDING_UPDATES = 256;
const DEFAULT_UPDATE_DELIVERY_TIMEOUT_MS = 10_000;

export interface AcpAgentOptions {
  /**
   * Canonical workspace root already enforced by the host's tools/sandbox.
   * ACP `cwd` must resolve to this same directory; the adapter does not
   * dynamically reconfigure tool roots.
   */
  workspaceRoot: string;
  /** Stable implementation identity reported during initialize. */
  name?: string;
  title?: string;
  version?: string;
  /** Maximum notifications waiting on a slow client for one prompt. */
  maxPendingUpdates?: number;
  /** Maximum time to wait for delivery of one session/update notification. */
  updateDeliveryTimeoutMs?: number;
  /** Optional bridge whose requestApproval hook was supplied to AgentLoop. */
  permissionBridge?: AcpPermissionBridge;
}

/** Build a stable ACP v1 agent over the protocol-neutral AgentRuntime. */
export function createAcpAgent(
  runtime: AgentRuntime,
  options: AcpAgentOptions,
): AgentApp {
  const workspaceRoot = resolveConfiguredWorkspaceRoot(options.workspaceRoot);
  const implementation: Implementation = {
    name: options.name ?? "42-agent",
    title: options.title ?? "42 Agent",
    version: options.version ?? "0.1.0",
  };
  const maxPendingUpdates = options.maxPendingUpdates ?? DEFAULT_MAX_PENDING_UPDATES;
  if (!Number.isSafeInteger(maxPendingUpdates) || maxPendingUpdates < 1) {
    throw new RangeError("maxPendingUpdates must be a positive safe integer");
  }
  const updateDeliveryTimeoutMs = options.updateDeliveryTimeoutMs
    ?? DEFAULT_UPDATE_DELIVERY_TIMEOUT_MS;
  if (!Number.isSafeInteger(updateDeliveryTimeoutMs) || updateDeliveryTimeoutMs < 1) {
    throw new RangeError("updateDeliveryTimeoutMs must be a positive safe integer");
  }

  const activePrompts = new Map<string, Set<AbortController>>();
  let activeConnection: AgentConnection | undefined;

  return agent({ name: implementation.name })
    .onConnect((connection) => {
      // AgentRuntime is a single-client process boundary. Keeping one live ACP
      // connection also lets session authorization and cancel ownership remain
      // unambiguous without leaking SDK connection internals into the Runtime.
      if (activeConnection || activePrompts.size > 0) {
        connection.close(new Error("This ACP agent already has an active client connection"));
        return;
      }
      activeConnection = connection;
      connection.signal.addEventListener("abort", () => {
        if (activeConnection === connection) {
          activeConnection = undefined;
        }
      }, { once: true });
    })
    .onRequest(methods.agent.initialize, async () => {
      const capabilities = await runtime.capabilities();
      return {
        protocolVersion: PROTOCOL_VERSION,
        agentCapabilities: {
          loadSession: false,
          promptCapabilities: {},
          sessionCapabilities: {
            delete: {},
            ...(capabilities.sessionResume ? { resume: {} } : {}),
          },
        },
        authMethods: [],
        agentInfo: implementation,
      };
    })
    .onRequest(methods.agent.session.new, async ({ params }) => {
      await validateWorkspaceRequest(params, workspaceRoot);
      try {
        const created = await runtime.createSession({
          metadata: { [ACP_CWD_METADATA]: workspaceRoot },
        });
        return { sessionId: created.sessionId };
      } catch (error) {
        throw toRequestError(error);
      }
    })
    .onRequest(methods.agent.session.resume, async ({ params }) => {
      await validateWorkspaceRequest(params, workspaceRoot);
      try {
        await assertSessionWorkspace(runtime, params.sessionId, workspaceRoot, false);
        const resumed = await runtime.resumeSession(params.sessionId);
        // Re-check the returned snapshot so a delete/recreate race cannot cross
        // the adapter boundary. Keep foreign and missing Sessions indistinguishable.
        if (resumed.metadata[ACP_CWD_METADATA] !== workspaceRoot) {
          throw RequestError.resourceNotFound(`session:${params.sessionId}`);
        }
        return {};
      } catch (error) {
        throw toRequestError(error, params.sessionId);
      }
    })
    .onRequest(methods.agent.session.delete, async ({ params }) => {
      try {
        await assertSessionWorkspace(runtime, params.sessionId, workspaceRoot, true);
        abortPrompts(activePrompts, params.sessionId, "Session deleted by ACP client");
        await runtime.closeSession(params.sessionId);
        return {};
      } catch (error) {
        throw toRequestError(error, params.sessionId);
      }
    })
    .onRequest(methods.agent.session.prompt, async (context) => {
      await assertSessionWorkspace(runtime, context.params.sessionId, workspaceRoot, false);
      const controller = new AbortController();
      const detachRequestSignal = forwardAbort(context.signal, controller);
      const controllers = activePrompts.get(context.params.sessionId) ?? new Set();
      controllers.add(controller);
      activePrompts.set(context.params.sessionId, controllers);
      const projector = new AcpUpdateProjector({
        sessionId: context.params.sessionId,
        client: context.client,
        maxPendingUpdates,
        signal: controller.signal,
        deliveryTimeoutMs: updateDeliveryTimeoutMs,
        onFailure: (error) => controller.abort(error),
      });

      try {
        const prompt = normalizePrompt(context.params.prompt);
        const run = () => runtime.prompt({
          sessionId: context.params.sessionId,
          content: prompt,
          signal: controller.signal,
          onEvent(event) {
            options.permissionBridge?.observe(event);
            projector.observe(event);
          },
        });
        const result = await (options.permissionBridge
          ? options.permissionBridge.run({
            client: context.client,
            sessionId: context.params.sessionId,
            signal: controller.signal,
          }, run)
          : run());
        projector.ensureFinalText(result.content.map((part) => part.text).join(""), result.runId);
        await projector.drain();
        if (controller.signal.aborted) return { stopReason: "cancelled" };
        return { stopReason: result.stopReason === "cancelled" ? "cancelled" : "end_turn" };
      } catch (error) {
        // Runtime.close() aborts its internal controller, while ACP permission
        // requests use this outer scope. Close it before draining updates so a
        // pending permission RPC or notification cannot survive the prompt.
        if (isAbortError(error) && !controller.signal.aborted) {
          controller.abort(error);
        }
        try {
          await projector.drain();
        } catch (projectionError) {
          throw toRequestError(projectionError);
        }
        if (controller.signal.aborted || isAbortError(error)) {
          return { stopReason: "cancelled" };
        }
        throw toRequestError(error, context.params.sessionId);
      } finally {
        if (!controller.signal.aborted) {
          controller.abort(new DOMException("ACP prompt scope ended", "AbortError"));
        }
        detachRequestSignal();
        controllers.delete(controller);
        if (controllers.size === 0) activePrompts.delete(context.params.sessionId);
      }
    })
    .onNotification(methods.agent.session.cancel, ({ params }) => {
      if (!activePrompts.has(params.sessionId)) return;
      abortPrompts(activePrompts, params.sessionId, "Cancelled by ACP client");
      runtime.cancel(params.sessionId, "Cancelled by ACP client");
    });
}

async function assertSessionWorkspace(
  runtime: AgentRuntime,
  sessionId: string,
  workspaceRoot: string,
  allowMissing: boolean,
): Promise<void> {
  let session;
  try {
    session = await runtime.getSession(sessionId);
  } catch (error) {
    throw toRequestError(error, sessionId);
  }
  if (!session) {
    if (allowMissing) return;
    throw RequestError.resourceNotFound(`session:${sessionId}`);
  }
  if (session.metadata[ACP_CWD_METADATA] !== workspaceRoot) {
    // Do not expose whether a foreign/unbound Session exists.
    throw RequestError.resourceNotFound(`session:${sessionId}`);
  }
}

function normalizePrompt(prompt: readonly ContentBlock[]): Array<{ type: "text"; text: string }> {
  if (prompt.length === 0) {
    throw RequestError.invalidParams({ prompt }, "prompt must contain at least one content block");
  }
  return prompt.map((block) => {
    if (block.type === "text") return { type: "text", text: block.text };
    if (block.type === "resource_link") {
      return {
        type: "text",
        text: `\n[ACP resource link: ${JSON.stringify({
          uri: block.uri,
          name: block.name,
          title: block.title,
          description: block.description,
          mimeType: block.mimeType,
        })}]\n`,
      };
    }
    throw RequestError.invalidParams(
      { contentType: block.type },
      `unsupported prompt content type ${block.type}`,
    );
  });
}

async function validateWorkspaceRequest(
  request: NewSessionRequest | ResumeSessionRequest,
  workspaceRoot: string,
): Promise<void> {
  if (!isAbsolute(request.cwd)) {
    throw RequestError.invalidParams({ cwd: request.cwd }, "cwd must be an absolute path");
  }
  if (request.additionalDirectories?.length) {
    throw RequestError.invalidParams(
      { additionalDirectories: request.additionalDirectories },
      "additionalDirectories are not supported by this runtime",
    );
  }
  if (request.mcpServers?.length) {
    throw RequestError.invalidParams(
      { count: request.mcpServers.length },
      "ACP-managed MCP server connections are not supported by this adapter",
    );
  }
  let requestedRoot: string;
  try {
    requestedRoot = await realpath(request.cwd);
    if (!(await stat(requestedRoot)).isDirectory()) {
      throw new Error("path is not a directory");
    }
  } catch (error) {
    throw RequestError.invalidParams(
      { cwd: request.cwd, error: error instanceof Error ? error.message : String(error) },
      "cwd must resolve to an existing directory",
    );
  }
  if (requestedRoot !== workspaceRoot) {
    throw RequestError.invalidParams(
      { configuredWorkspaceRoot: workspaceRoot, requestedCwd: requestedRoot },
      "cwd must resolve to the Agent's configured workspace root",
    );
  }
}

function resolveConfiguredWorkspaceRoot(workspaceRoot: string): string {
  if (!isAbsolute(workspaceRoot)) {
    throw new TypeError("workspaceRoot must be an absolute path");
  }
  try {
    const resolved = realpathSync(workspaceRoot);
    if (!statSync(resolved).isDirectory()) {
      throw new Error("path is not a directory");
    }
    return resolved;
  } catch (error) {
    throw new TypeError(
      `workspaceRoot must resolve to an existing directory: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function abortPrompts(
  prompts: ReadonlyMap<string, ReadonlySet<AbortController>>,
  sessionId: string,
  reason: string,
): void {
  for (const controller of prompts.get(sessionId) ?? []) {
    controller.abort(new DOMException(reason, "AbortError"));
  }
}

function forwardAbort(source: AbortSignal, target: AbortController): () => void {
  const abort = (): void => target.abort(source.reason);
  if (source.aborted) abort();
  else source.addEventListener("abort", abort, { once: true });
  return () => source.removeEventListener("abort", abort);
}

function toRequestError(error: unknown, sessionId?: string): RequestError {
  if (error instanceof RequestError) return error;
  if (error instanceof SessionNotFoundError) {
    return RequestError.resourceNotFound(`session:${sessionId ?? "unknown"}`);
  }
  if (error instanceof SessionClosingError) {
    return RequestError.invalidRequest(
      { sessionId },
      "session is closing",
    );
  }
  if (error instanceof RuntimeClosedError) {
    return RequestError.internalError(undefined, "agent runtime is closed");
  }
  return RequestError.internalError(
    error instanceof Error ? { name: error.name, message: error.message } : { error: String(error) },
  );
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError"
    || error instanceof RequestError && error.code === -32800;
}
