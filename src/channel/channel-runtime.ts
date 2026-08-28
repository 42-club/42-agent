import type { AgentRuntime } from "../agent-runtime.js";
import {
  defaultSessionIdResolver,
  type ChannelAdapter,
  type SessionIdResolver,
} from "./types.js";

export interface ChannelRuntimeOptions {
  resolveSessionId?: SessionIdResolver;
  skills?: readonly string[];
  tools?: readonly string[];
}

export interface ChannelHandleOptions {
  signal?: AbortSignal;
}

/**
 * Stateless bridge between a frontend channel and AgentRuntime.
 * It never stores or reconstructs conversation history.
 */
export class ChannelRuntime<RawEvent = unknown> {
  private readonly resolveSessionId: SessionIdResolver;

  constructor(
    private readonly agentRuntime: AgentRuntime,
    private readonly channel: ChannelAdapter<RawEvent>,
    private readonly options: ChannelRuntimeOptions = {},
  ) {
    this.resolveSessionId = options.resolveSessionId ?? defaultSessionIdResolver;
  }

  async handle(event: RawEvent, options: ChannelHandleOptions = {}): Promise<boolean> {
    const inbound = await this.channel.normalize(event);
    if (!inbound) return false;

    const injection = this.channel.promptInjection?.(inbound);
    let eventTail = Promise.resolve();
    const result = await this.agentRuntime.prompt({
      sessionId: this.resolveSessionId(inbound),
      content: [{ type: "text", text: inbound.text }],
      createIfMissing: true,
      promptInjections: injection ? [injection] : [],
      skills: this.options.skills,
      tools: this.options.tools,
      signal: options.signal,
      onEvent: (agentEvent) => {
        eventTail = eventTail
          .then(() => this.channel.onAgentEvent?.(agentEvent, inbound))
          .catch(() => undefined);
      },
    });
    // Core execution never awaits a Channel observer. The adapter owns ordered
    // projection and joins its own queue before sending the final reply.
    await eventTail;
    await this.channel.send({
      conversationId: inbound.conversationId,
      text: result.content.map((part) => part.text).join(""),
      replyToMessageId: inbound.messageId,
      metadata: { sourceChannel: inbound.channel },
    });
    return true;
  }
}
