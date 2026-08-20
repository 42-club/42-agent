import { estimateTokens, type ModelClient } from "../model.js";
import { createMessage } from "../session.js";
import type { Tool, ToolContext } from "./base.js";

export interface CompressionOptions {
  batchSize?: number;
  retainRecent?: number;
  preserveRecentTokens?: number;
  targetRatio?: number;
}

export class ConversationCompressionTool implements Tool {
  readonly name = "compress_conversation";
  readonly description = "使用小模型总结较早的会话消息，并保留最近的消息。";
  readonly inputSchema = { type: "object", properties: {}, additionalProperties: false };
  readonly sessionAccess = "write" as const;
  readonly batchSize: number;
  readonly retainRecent: number;
  readonly preserveRecentTokens: number;
  readonly targetRatio: number;

  constructor(
    private readonly summarizer: ModelClient,
    options: CompressionOptions = {},
  ) {
    this.batchSize = options.batchSize ?? 100;
    this.retainRecent = options.retainRecent ?? 20;
    this.preserveRecentTokens = options.preserveRecentTokens ?? 8_000;
    this.targetRatio = options.targetRatio ?? 0.2;
    if (this.retainRecent >= this.batchSize) {
      throw new Error("retainRecent must be smaller than batchSize");
    }
  }

  async execute(_arguments: Record<string, unknown>, context: ToolContext): Promise<unknown> {
    const mutableSession = context.mutableSession;
    if (!mutableSession) throw new Error("Conversation compression requires session write access");
    const messages = mutableSession.messages;
    if (messages.length < 2) {
      return { compressed: false, messageCount: messages.length };
    }

    let recentStart = messages.length;
    let recentTokens = 0;
    while (recentStart > 0 && recentTokens < this.preserveRecentTokens) {
      const candidate = messages[recentStart - 1]!;
      recentTokens += estimateTokens(candidate.content) + 4;
      recentStart -= 1;
    }
    const minimumRecentStart = Math.max(0, messages.length - this.retainRecent);
    recentStart = Math.min(recentStart, minimumRecentStart);
    if (recentStart === 0) return { compressed: false, messageCount: messages.length };
    const recent = messages.slice(recentStart);
    const toSummarize = messages.slice(0, recentStart);
    const transcript = toSummarize.map((message) => `${message.role}: ${message.content}`).join("\n");
    const targetTokens = Math.max(128, Math.floor(estimateTokens(transcript) * this.targetRatio));
    const response = await this.summarizer.complete({
      messages: [createMessage({ role: "user", content: transcript })],
      tools: [],
      systemPrompt:
        `请忠实总结会话，保留目标、决定、约束、未完成事项和关键事实。不要添加原文不存在的信息。摘要目标不超过约 ${targetTokens} tokens。`,
    });
    const summary = createMessage({
      role: "system",
      content: `会话压缩摘要：\n${response.content ?? ""}`,
      metadata: { kind: "conversation_summary", sourceCount: toSummarize.length },
    });
    mutableSession.messages = [summary, ...recent];
    return {
      compressed: true,
      summarizedCount: toSummarize.length,
      retainedCount: recent.length,
      messageCount: mutableSession.messages.length,
    };
  }
}
