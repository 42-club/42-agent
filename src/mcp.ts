import type { Tool, ToolContext } from "./tools/base.js";

export interface MCPToolDefinition {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  /** MCP capabilities default to exclusive unless explicitly safe to parallelize. */
  executionPolicy?: "parallel" | "exclusive";
}

export interface MCPClient {
  listTools(): Promise<readonly MCPToolDefinition[]>;
  callTool(
    name: string,
    arguments_: Record<string, unknown>,
    options?: { signal?: AbortSignal },
  ): Promise<unknown>;
}

class MCPToolAdapter implements Tool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly executionPolicy: "parallel" | "exclusive";

  constructor(
    private readonly client: MCPClient,
    definition: MCPToolDefinition,
  ) {
    this.name = definition.name;
    this.description = definition.description ?? "";
    this.inputSchema = definition.inputSchema ?? { type: "object" };
    this.executionPolicy = definition.executionPolicy ?? "exclusive";
  }

  async execute(arguments_: Record<string, unknown>, context: ToolContext): Promise<unknown> {
    return this.client.callTool(this.name, arguments_, { signal: context.signal });
  }
}

export async function loadMCPTools(client: MCPClient): Promise<Tool[]> {
  return (await client.listTools()).map((definition) => new MCPToolAdapter(client, definition));
}
