import { AgentLoop, AgentRuntime, ConversationCompressionTool, SqliteSessionStore, ToolRegistry, createAgentRuntimeHttpServer, createAiSdkOpenRouterClient } from "../src/index.js";

const apiKey = process.env.OPENROUTER_API_KEY ?? "";
if (!apiKey) throw new Error("OPENROUTER_API_KEY is required");
const model = createAiSdkOpenRouterClient({ apiKey, model: process.env.OPENROUTER_MODEL ?? "anthropic/claude-opus-4.6" });
const summarizer = createAiSdkOpenRouterClient({ apiKey, model: process.env.OPENROUTER_SUMMARY_MODEL ?? "openai/gpt-4.1-mini" });
const tools = new ToolRegistry();
tools.register(new ConversationCompressionTool(summarizer));
const sessionStore = new SqliteSessionStore(".agent-data/runtime.sqlite");
const loop = new AgentLoop({ model, tools, sessionStore, requestApproval: async () => false });
const agentRuntime = new AgentRuntime({ loop });
const server = createAgentRuntimeHttpServer(agentRuntime, { host: process.env.AGENT_RUNTIME_HOST, port: Number(process.env.AGENT_RUNTIME_PORT ?? 8787) });
const address = await server.listen();
console.log(`Agent Runtime listening on http://${address.host}:${address.port}`);
