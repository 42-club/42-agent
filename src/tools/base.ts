import Ajv2020, { type ValidateFunction } from "ajv/dist/2020.js";
import type { ToolDefinition } from "../model.js";
import type { ReadonlySession, Session } from "../session.js";

export type ApprovalHandler = (question: string, signal?: AbortSignal) => Promise<boolean>;

export interface ToolContext {
  /** Deeply immutable snapshot. It never aliases the Runtime's live Session. */
  readonly session: ReadonlySession;
  /** Present only for tools explicitly registered with sessionAccess: "write". */
  readonly mutableSession?: Session;
  readonly requestApproval: ApprovalHandler;
  readonly signal?: AbortSignal;
}

/** Mutable execution state kept inside AgentLoop and never passed directly to a Tool. */
export interface ToolExecutionContext {
  session: Session;
  requestApproval: ApprovalHandler;
  signal?: AbortSignal;
}

export interface Tool extends ToolDefinition {
  /**
   * Write access is trusted, executes as an exclusive barrier, and checkpoints
   * the complete message history because existing messages may have changed.
   */
  sessionAccess?: "read" | "write";
  /** Use exclusive for capabilities whose external effects must not overlap or reorder. */
  executionPolicy?: "parallel" | "exclusive";
  execute(arguments_: Record<string, unknown>, context: ToolContext): Promise<unknown>;
}

export interface ToolDescriptor extends ToolDefinition {
  sessionAccess: "read" | "write";
  executionPolicy: "parallel" | "exclusive";
}

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();
  private readonly validators = new Map<string, ValidateFunction>();
  private errorFormatter?: (
    errors?: ValidateFunction["errors"],
    options?: { separator: string },
  ) => string;
  private ajv?: {
    compile(schema: object): ValidateFunction;
    errorsText(errors?: ValidateFunction["errors"], options?: { separator: string }): string;
  };

  register(tool: Tool): void {
    if (this.tools.has(tool.name)) throw new Error(`Tool already registered: ${tool.name}`);
    const registered = snapshotTool(tool);
    const validator = this.compiler().compile(registered.inputSchema);
    this.tools.set(registered.name, registered);
    this.validators.set(registered.name, validator);
  }

  unregister(name: string): boolean {
    this.validators.delete(name);
    return this.tools.delete(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  validate(name: string, input: unknown): asserts input is Record<string, unknown> {
    const validate = this.validators.get(name);
    if (!validate) throw new Error(`Unknown tool: ${name}`);
    if (!validate(input)) {
      const details = this.formatValidationErrors(validate.errors);
      throw new InvalidToolInputError(name, details);
    }
  }

  contextFor(tool: Tool, context: ToolExecutionContext): ToolContext {
    return {
      session: immutableSessionSnapshot(context.session),
      // Tools keep the ergonomic one-argument API while the host approval
      // transport receives the canonical turn signal automatically.
      requestApproval: (question, signal) => {
        const approvalSignal = context.signal && signal
          ? AbortSignal.any([context.signal, signal])
          : signal ?? context.signal;
        return context.requestApproval(question, approvalSignal);
      },
      signal: context.signal,
      mutableSession: tool.sessionAccess === "write" ? context.session : undefined,
    };
  }

  get(name: string): Tool {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Unknown tool: ${name}`);
    return tool;
  }

  definitions(names?: readonly string[]): ToolDefinition[] {
    const selected = names ? names.map((name) => this.get(name)) : [...this.tools.values()];
    return selected.map(({ name, description, inputSchema }) => ({
      name,
      description,
      inputSchema,
    }));
  }

  descriptors(): ToolDescriptor[] {
    return [...this.tools.values()].map(({ name, description, inputSchema }) => ({
      name,
      description,
      inputSchema,
      sessionAccess: this.tools.get(name)?.sessionAccess ?? "read",
      executionPolicy: this.effectiveExecutionPolicy(this.get(name)),
    }));
  }

  select(names: readonly string[]): ToolRegistry {
    return this.snapshot(names);
  }

  /**
   * Capture the capabilities exposed to one Turn.
   *
   * Tool implementations may retain their own internal state, so execution is
   * bound to the implementation object that was registered at capture time.
   * Registry membership and all host-controlled descriptor fields are copied;
   * later registration changes or mutations of the original Tool object cannot
   * change this snapshot's model definitions, validation, or scheduling policy.
   */
  snapshot(names?: readonly string[]): ToolRegistry {
    const registry = new ToolRegistry();
    const selected = names ? names.map((name) => this.get(name)) : [...this.tools.values()];
    for (const tool of selected) {
      if (registry.tools.has(tool.name)) {
        throw new Error(`Tool already registered: ${tool.name}`);
      }
      // Registered Tool descriptors are already frozen and their execute
      // implementation is already bound. Copying those references plus the
      // compiled validator gives this membership snapshot O(number of tools)
      // cost without recompiling every JSON Schema on every Turn.
      registry.tools.set(tool.name, tool);
      registry.validators.set(tool.name, this.validators.get(tool.name)!);
    }
    registry.errorFormatter = this.errorFormatter;
    return registry;
  }

  effectiveExecutionPolicy(tool: Tool): "parallel" | "exclusive" {
    return tool.sessionAccess === "write" ? "exclusive" : tool.executionPolicy ?? "parallel";
  }

  private compiler(): NonNullable<ToolRegistry["ajv"]> {
    this.ajv ??= new (Ajv2020 as unknown as new (options: object) => {
      compile(schema: object): ValidateFunction;
      errorsText(errors?: ValidateFunction["errors"], options?: { separator: string }): string;
    })({ allErrors: true, strict: false });
    this.errorFormatter ??= this.ajv.errorsText.bind(this.ajv);
    return this.ajv;
  }

  private formatValidationErrors(errors?: ValidateFunction["errors"]): string {
    if (!this.errorFormatter) this.compiler();
    return this.errorFormatter!(errors, { separator: "; " });
  }
}

function snapshotTool(tool: Tool): Tool {
  const execute = tool.execute.bind(tool);
  return Object.freeze({
    name: tool.name,
    description: tool.description,
    inputSchema: deepFreeze(structuredClone(tool.inputSchema)),
    sessionAccess: tool.sessionAccess,
    executionPolicy: tool.executionPolicy,
    execute,
  });
}

function immutableSessionSnapshot(session: Session): ReadonlySession {
  return deepFreeze(structuredClone(session)) as ReadonlySession;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    deepFreeze((value as Record<PropertyKey, unknown>)[key], seen);
  }
  return Object.freeze(value);
}

export class InvalidToolInputError extends Error {
  constructor(toolName: string, details: string) {
    super(`Invalid input for tool ${toolName}: ${details}`);
    this.name = "InvalidToolInputError";
  }
}
