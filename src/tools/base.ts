import Ajv2020, { type ValidateFunction } from "ajv/dist/2020.js";
import type { ToolDefinition } from "../model.js";
import type { Session } from "../session.js";

export type ApprovalHandler = (question: string) => Promise<boolean>;

export interface ToolContext {
  readonly session: Session;
  /** Present only for tools explicitly registered with sessionAccess: "write". */
  mutableSession?: Session;
  requestApproval: ApprovalHandler;
  signal?: AbortSignal;
}

export interface Tool extends ToolDefinition {
  sessionAccess?: "read" | "write";
  execute(arguments_: Record<string, unknown>, context: ToolContext): Promise<unknown>;
}

export interface ToolDescriptor extends ToolDefinition {
  sessionAccess: "read" | "write";
}

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();
  private readonly validators = new Map<string, ValidateFunction>();
  private readonly ajv: {
    compile(schema: object): ValidateFunction;
    errorsText(errors?: ValidateFunction["errors"], options?: { separator: string }): string;
  } = new (Ajv2020 as unknown as new (options: object) => {
    compile(schema: object): ValidateFunction;
    errorsText(errors?: ValidateFunction["errors"], options?: { separator: string }): string;
  })({ allErrors: true, strict: false });

  register(tool: Tool): void {
    if (this.tools.has(tool.name)) throw new Error(`Tool already registered: ${tool.name}`);
    this.tools.set(tool.name, tool);
    this.validators.set(tool.name, this.ajv.compile(tool.inputSchema));
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
      const details = this.ajv.errorsText(validate.errors, { separator: "; " });
      throw new InvalidToolInputError(name, details);
    }
  }

  contextFor(tool: Tool, context: ToolContext): ToolContext {
    return tool.sessionAccess === "write"
      ? { ...context, mutableSession: context.session as Session }
      : { ...context, mutableSession: undefined };
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
    }));
  }

  select(names: readonly string[]): ToolRegistry {
    const registry = new ToolRegistry();
    for (const name of names) registry.register(this.get(name));
    return registry;
  }
}

export class InvalidToolInputError extends Error {
  constructor(toolName: string, details: string) {
    super(`Invalid input for tool ${toolName}: ${details}`);
    this.name = "InvalidToolInputError";
  }
}
