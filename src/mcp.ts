import type { Tool, ToolContext } from "./tools/base.js";

export interface MCPToolAnnotations {
  title?: string;
  /** Defaults to false according to the MCP specification. */
  readOnlyHint?: boolean;
  /** Defaults to true and is meaningful only for non-read-only tools. */
  destructiveHint?: boolean;
  /** Defaults to false and is meaningful only for non-read-only tools. */
  idempotentHint?: boolean;
  /** Defaults to true according to the MCP specification. */
  openWorldHint?: boolean;
}

export interface MCPToolDefinition {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: MCPToolAnnotations;
  _meta?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface MCPContentBlock {
  type: string;
  [key: string]: unknown;
}

export interface MCPCallToolResult {
  content?: readonly MCPContentBlock[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface MCPClientRequestOptions {
  signal?: AbortSignal;
}

export interface MCPClient {
  listTools(options?: MCPClientRequestOptions): Promise<readonly MCPToolDefinition[]>;
  callTool(
    name: string,
    arguments_: Record<string, unknown>,
    options?: MCPClientRequestOptions,
  ): Promise<unknown>;
  /** Close the underlying transport, if the client owns one. */
  close?(): void | Promise<void>;
}

export interface MCPResolvedToolAnnotations {
  readonly title?: string;
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
  readonly idempotentHint: boolean;
  readonly openWorldHint: boolean;
}

export interface MCPToolMetadata {
  readonly title?: string;
  readonly annotations: MCPResolvedToolAnnotations;
  readonly annotationsTrusted: boolean;
  readonly outputSchema?: Readonly<Record<string, unknown>>;
  readonly _meta?: Readonly<Record<string, unknown>>;
}

/** A runtime Tool with the original MCP-specific behavior metadata retained. */
export interface MCPAdaptedTool extends Tool {
  readonly mcp: MCPToolMetadata;
}

export interface MCPToolProviderRefreshOptions {
  signal?: AbortSignal;
}

export interface MCPToolProviderOptions {
  /**
   * MCP annotations are untrusted hints by specification. Opt in only when the
   * configured server is trusted to describe tool behavior faithfully.
   */
  trustToolAnnotations?: boolean;
  /** Local host policy. A same-named field received from the server is ignored. */
  executionPolicyFor?: (
    definition: Readonly<MCPToolDefinition>,
  ) => "parallel" | "exclusive" | undefined;
}

/** An MCP tool-level failure (`CallToolResult.isError === true`). */
export class MCPToolCallError extends Error {
  readonly toolName: string;
  readonly result: MCPCallToolResult;

  constructor(toolName: string, result: MCPCallToolResult) {
    super(`MCP tool "${toolName}" failed: ${describeMCPError(result)}`);
    this.name = "MCPToolCallError";
    this.toolName = toolName;
    this.result = result;
  }
}

/** A JSON-RPC/MCP protocol error returned as a value by a thin client. */
export class MCPProtocolError extends Error {
  readonly toolName: string;
  readonly protocolError: unknown;

  constructor(toolName: string, protocolError: unknown) {
    super(`MCP call for tool "${toolName}" failed: ${describeUnknownError(protocolError)}`);
    this.name = "MCPProtocolError";
    this.toolName = toolName;
    this.protocolError = protocolError;
  }
}

export class MCPToolProviderClosedError extends Error {
  constructor() {
    super("MCP tool provider is closed");
    this.name = "MCPToolProviderClosedError";
  }
}

class MCPToolAdapter implements MCPAdaptedTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly executionPolicy: "parallel" | "exclusive";
  readonly mcp: MCPToolMetadata;

  constructor(
    private readonly callTool: MCPClient["callTool"],
    definition: MCPToolDefinition,
    private readonly assertProviderOpen: () => void,
    private readonly trustToolAnnotations: boolean,
    executionPolicyOverride: "parallel" | "exclusive" | undefined,
  ) {
    const annotations = resolveAnnotations(definition);
    this.name = definition.name;
    this.description = describeTool(definition, annotations, trustToolAnnotations);
    this.inputSchema = structuredClone(definition.inputSchema ?? { type: "object" });
    this.executionPolicy = executionPolicyOverride
      ?? (trustToolAnnotations && annotations.readOnlyHint ? "parallel" : "exclusive");
    this.mcp = Object.freeze({
      title: definition.title ?? annotations.title,
      annotations,
      annotationsTrusted: trustToolAnnotations,
      outputSchema: cloneAndFreezeRecord(definition.outputSchema),
      _meta: cloneAndFreezeRecord(definition._meta),
    });
  }

  async execute(arguments_: Record<string, unknown>, context: ToolContext): Promise<unknown> {
    this.assertProviderOpen();
    throwIfAborted(context.signal);
    const argumentsSnapshot = structuredClone(arguments_);
    if (!this.trustToolAnnotations || !this.mcp.annotations.readOnlyHint) {
      const approved = await waitForApproval(
        () => context.requestApproval(this.approvalQuestion(argumentsSnapshot)),
        context.signal,
      );
      if (!approved) {
        return {
          approved: false,
          executed: false,
          error: "MCPToolApprovalDenied",
          message: `MCP tool "${this.name}" was not approved`,
        };
      }
    }

    this.assertProviderOpen();
    throwIfAborted(context.signal);
    const result = await this.callTool(this.name, argumentsSnapshot, {
      signal: context.signal,
    });
    return normalizeMCPResult(this.name, result);
  }

  private approvalQuestion(arguments_: Record<string, unknown>): string {
    const { annotations } = this.mcp;
    const effect = !this.trustToolAnnotations
      ? "is remote and its behavior annotations are not trusted"
      : annotations.destructiveHint
        ? "may perform destructive remote changes"
        : "may modify remote state";
    const retry = annotations.idempotentHint
      ? "The server reports this operation as idempotent."
      : "Repeating this operation may cause additional effects.";
    const title = this.mcp.title;
    const identity = title && title !== this.name
      ? `${JSON.stringify(this.name)} (server title ${JSON.stringify(title)})`
      : JSON.stringify(this.name);
    return [
      `MCP tool ${identity} ${effect}.`,
      retry,
      `Arguments: ${safeStringify(arguments_)}`,
      "Allow this tool call?",
    ].join("\n");
  }
}

/**
 * Owns an MCP client's tool snapshot and transport lifecycle. Refresh returns a
 * new snapshot; adapters from an older snapshot remain usable until close().
 * Closing gates new work, drains admitted client requests, then closes the client.
 */
export class MCPToolProvider {
  private snapshot: readonly MCPAdaptedTool[] = Object.freeze([]);
  private closed = false;
  private closePromise: Promise<void> | undefined;
  private refreshSequence = 0;
  private readonly inFlight = new Set<Promise<unknown>>();

  private readonly trustToolAnnotations: boolean;
  private readonly executionPolicyFor: NonNullable<MCPToolProviderOptions["executionPolicyFor"]>
    | undefined;

  constructor(
    private readonly client: MCPClient,
    options: MCPToolProviderOptions = {},
  ) {
    this.trustToolAnnotations = options.trustToolAnnotations ?? false;
    this.executionPolicyFor = options.executionPolicyFor;
  }

  get tools(): readonly MCPAdaptedTool[] {
    return this.snapshot;
  }

  async load(options: MCPToolProviderRefreshOptions = {}): Promise<MCPAdaptedTool[]> {
    return this.refresh(options);
  }

  async refresh(options: MCPToolProviderRefreshOptions = {}): Promise<MCPAdaptedTool[]> {
    this.assertOpen();
    throwIfAborted(options.signal);
    const sequence = ++this.refreshSequence;
    const definitions = await this.runClientOperation(() => (
      this.client.listTools({ signal: options.signal })
    ));
    this.assertOpen();
    throwIfAborted(options.signal);
    assertValidDefinitions(definitions);
    const next = definitions.map((definition) => new MCPToolAdapter(
      (name, arguments_, callOptions) => this.runClientOperation(() => (
        this.client.callTool(name, arguments_, callOptions)
      )),
      definition,
      () => this.assertOpen(),
      this.trustToolAnnotations,
      this.resolveExecutionPolicy(definition),
    ));
    this.assertOpen();
    // A slower, older refresh must not overwrite a newer snapshot.
    if (sequence === this.refreshSequence) this.snapshot = Object.freeze(next);
    return [...next];
  }

  close(): Promise<void> {
    if (!this.closePromise) {
      this.closed = true;
      this.snapshot = Object.freeze([]);
      const admitted = [...this.inFlight];
      this.closePromise = Promise.allSettled(admitted)
        .then(() => this.client.close?.());
    }
    return this.closePromise;
  }

  private assertOpen(): void {
    if (this.closed) throw new MCPToolProviderClosedError();
  }

  private runClientOperation<Result>(operation: () => Promise<Result>): Promise<Result> {
    this.assertOpen();
    const pending = Promise.resolve().then(operation);
    this.inFlight.add(pending);
    return pending.finally(() => {
      this.inFlight.delete(pending);
    });
  }

  private resolveExecutionPolicy(
    definition: MCPToolDefinition,
  ): "parallel" | "exclusive" | undefined {
    if (!this.executionPolicyFor) return undefined;
    const snapshot = deepFreeze(structuredClone(definition));
    const policy = this.executionPolicyFor(snapshot);
    if (policy !== undefined && policy !== "parallel" && policy !== "exclusive") {
      throw new TypeError(`Invalid local execution policy for MCP tool "${definition.name}"`);
    }
    return policy;
  }
}

/** Convenience one-shot snapshot loader. The caller retains client ownership. */
export async function loadMCPTools(
  client: MCPClient,
  options: MCPToolProviderOptions = {},
): Promise<MCPAdaptedTool[]> {
  return new MCPToolProvider(client, options).load();
}

function resolveAnnotations(definition: MCPToolDefinition): MCPResolvedToolAnnotations {
  const annotations = definition.annotations ?? {};
  return Object.freeze({
    title: annotations.title,
    readOnlyHint: annotations.readOnlyHint ?? false,
    destructiveHint: annotations.destructiveHint ?? true,
    idempotentHint: annotations.idempotentHint ?? false,
    openWorldHint: annotations.openWorldHint ?? true,
  });
}

function describeTool(
  definition: MCPToolDefinition,
  annotations: MCPResolvedToolAnnotations,
  annotationsTrusted: boolean,
): string {
  const behavior = JSON.stringify({
    trusted: annotationsTrusted,
    readOnlyHint: annotations.readOnlyHint,
    destructiveHint: annotations.destructiveHint,
    idempotentHint: annotations.idempotentHint,
    openWorldHint: annotations.openWorldHint,
  });
  const displayTitle = definition.title ?? annotations.title;
  const title = displayTitle ? `MCP title: ${displayTitle}` : undefined;
  return [definition.description?.trim(), title, `MCP annotations: ${behavior}`]
    .filter((part): part is string => Boolean(part))
    .join("\n\n");
}

function normalizeMCPResult(toolName: string, result: unknown): unknown {
  if (isProtocolErrorEnvelope(result)) {
    throw new MCPProtocolError(toolName, result.error);
  }
  if (isProtocolSuccessEnvelope(result)) {
    return normalizeMCPResult(toolName, result.result);
  }
  if (isRecord(result) && result.isError === true) {
    throw new MCPToolCallError(toolName, result as MCPCallToolResult);
  }
  return result;
}

function isProtocolErrorEnvelope(value: unknown): value is { error: unknown } {
  return isRecord(value) && value.jsonrpc === "2.0" && "error" in value;
}

function isProtocolSuccessEnvelope(value: unknown): value is { result: unknown } {
  return isRecord(value) && value.jsonrpc === "2.0" && "result" in value;
}

function describeMCPError(result: MCPCallToolResult): string {
  const text = (Array.isArray(result.content) ? result.content : [])
    .filter((block) => isRecord(block) && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .filter(Boolean)
    .join("\n");
  if (text) return text;
  if (result.structuredContent !== undefined) return safeStringify(result.structuredContent);
  return "the server reported an unsuccessful tool result";
}

function describeUnknownError(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (isRecord(error) && typeof error.message === "string") {
    const code = "code" in error ? ` (${String(error.code)})` : "";
    return `${error.message}${code}`;
  }
  return safeStringify(error);
}

function assertValidDefinitions(definitions: readonly MCPToolDefinition[]): void {
  const names = new Set<string>();
  for (const definition of definitions) {
    if (!definition || typeof definition.name !== "string" || definition.name.length === 0) {
      throw new TypeError("MCP tool definitions must have a non-empty name");
    }
    if (names.has(definition.name)) {
      throw new Error(`Duplicate MCP tool definition: ${definition.name}`);
    }
    names.add(definition.name);
  }
}

function cloneAndFreezeRecord(
  value: Record<string, unknown> | undefined,
): Readonly<Record<string, unknown>> | undefined {
  return value === undefined ? undefined : deepFreeze(structuredClone(value));
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    deepFreeze((value as Record<PropertyKey, unknown>)[key], seen);
  }
  return Object.freeze(value);
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return "[unserializable value]";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function waitForApproval(
  requestApproval: () => Promise<boolean>,
  signal?: AbortSignal,
): Promise<boolean> {
  if (!signal) return requestApproval();
  throwIfAborted(signal);

  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  const pendingApproval = Promise.resolve().then(() => {
    throwIfAborted(signal);
    return requestApproval();
  });

  try {
    return await Promise.race([pendingApproval, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
    void pendingApproval.catch(() => undefined);
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal);
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Aborted", "AbortError");
}
