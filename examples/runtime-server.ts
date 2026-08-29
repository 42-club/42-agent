import { resolve } from "node:path";
import {
  AgentLoop,
  AgentRuntime,
  ConversationCompressionTool,
  ToolRegistry,
  createAgentRuntimeHttpServer,
  createAiSdkOpenRouterClient,
  openSessionStore,
  resolveSessionDatabaseConfig,
  type PostgresSchemaMode,
  type SessionDatabaseConfig,
} from "../src/index.js";

const apiKey = process.env.OPENROUTER_API_KEY ?? "";
if (!apiKey) throw new Error("OPENROUTER_API_KEY is required");
const model = createAiSdkOpenRouterClient({
  apiKey,
  model: process.env.OPENROUTER_MODEL ?? "anthropic/claude-opus-4.6",
});
const summarizer = createAiSdkOpenRouterClient({
  apiKey,
  model: process.env.OPENROUTER_SUMMARY_MODEL ?? "openai/gpt-4.1-mini",
});
const tools = new ToolRegistry();
tools.register(new ConversationCompressionTool(summarizer));

const schemaMode = process.env.AGENT_DATABASE_SCHEMA_MODE as PostgresSchemaMode | undefined;
const postgresUrl = process.env.AGENT_POSTGRES_URL;
const postgresMigrationUrl = process.env.AGENT_POSTGRES_MIGRATION_URL;
const supabaseUrl = process.env.SUPABASE_DATABASE_URL;
const supabaseMigrationUrl = process.env.SUPABASE_MIGRATION_URL;
const databaseConfig: SessionDatabaseConfig = {
  mode: process.env.AGENT_DATABASE_MODE as SessionDatabaseConfig["mode"],
  namespace: process.env.AGENT_DATABASE_NAMESPACE ?? "runtime-server",
  ...(postgresUrl || postgresMigrationUrl
    ? {
        postgres: {
          connectionString: postgresUrl ?? "",
          migrationConnectionString: postgresMigrationUrl,
          schemaMode,
        },
      }
    : {}),
  ...(supabaseUrl || supabaseMigrationUrl
    ? {
        supabase: {
          databaseUrl: supabaseUrl ?? "",
          migrationUrl: supabaseMigrationUrl,
          schemaMode,
        },
      }
    : {}),
  sqlite: {
    filename: resolve(process.env.AGENT_SQLITE_PATH ?? ".agent-data/runtime.sqlite"),
  },
};
console.log("Session database:", resolveSessionDatabaseConfig(databaseConfig));
const sessionStore = await openSessionStore(databaseConfig);
const loop = new AgentLoop({ model, tools, sessionStore, requestApproval: async () => false });
const agentRuntime = new AgentRuntime({ loop });
const server = createAgentRuntimeHttpServer(agentRuntime, {
  host: process.env.AGENT_RUNTIME_HOST,
  port: Number(process.env.AGENT_RUNTIME_PORT ?? 8787),
});

let closePromise: Promise<void> | undefined;
const close = (): Promise<void> => {
  closePromise ??= (async () => {
    try {
      await server.close();
    } finally {
      try {
        await agentRuntime.close();
      } finally {
        await sessionStore.close();
      }
    }
  })();
  return closePromise;
};
const closeOnSignal = (): void => {
  void close().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
};

try {
  const address = await server.listen();
  process.once("SIGINT", closeOnSignal);
  process.once("SIGTERM", closeOnSignal);
  console.log(`Agent Runtime listening on http://${address.host}:${address.port}`);
} catch (error) {
  await agentRuntime.close();
  await sessionStore.close();
  throw error;
}
