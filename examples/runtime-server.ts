import { AgentLoop, BashTool, ConversationCompressionTool, SqliteSessionStore, ToolRegistry, createAgentRuntimeHttpServer, createAiSdkOpenRouterClient } from "../src/index.js";

const apiKey = process.env.OPENROUTER_API_KEY ?? "";
if (!apiKey) throw new Error("OPENROUTER_API_KEY is required");
const model = createAiSdkOpenRouterClient({ apiKey, model: process.env.OPENROUTER_MODEL ?? "anthropic/claude-opus-4.6" });
const summarizer = createAiSdkOpenRouterClient({ apiKey, model: process.env.OPENROUTER_SUMMARY_MODEL ?? "openai/gpt-4.1-mini" });
const tools = new ToolRegistry();
tools.register(new ConversationCompressionTool(summarizer));
tools.register(new BashTool({ defaultCwd: process.cwd() }));
const loop = new AgentLoop({ model, tools, sessionStore: new SqliteSessionStore(".agent-data/runtime.sqlite"), requestApproval: async () => false });
const runtime = createAgentRuntimeHttpServer(loop, { host: process.env.AGENT_RUNTIME_HOST, port: Number(process.env.AGENT_RUNTIME_PORT ?? 8787) });
const address = await runtime.listen();
console.log(`Agent Runtime listening on http://${address.host}:${address.port}`);
