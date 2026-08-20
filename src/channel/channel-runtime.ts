import type { AgentLoop } from "../agent-loop.js";
import {
  defaultSessionIdResolver,
  type ChannelAdapter,
  type SessionIdResolver,
} from "./types.js";

export interface ChannelRuntimeOptions {
  resolveSessionId?: SessionIdResolver;
  skills?: readonly string[];
}

export interface ChannelHandleOptions {
  signal?: AbortSignal;
}

/**
 * Stateless bridge between a frontend channel and AgentLoop.
 * It never stores or reconstructs conversation history.
 */
export class ChannelRuntime<RawEvent = unknown> {
  private readonly resolveSessionId: SessionIdResolver;

  constructor(
    private readonly agentLoop: AgentLoop,
    private readonly channel: ChannelAdapter<RawEvent>,
    private readonly options: ChannelRuntimeOptions = {},
  ) {
    this.resolveSessionId = options.resolveSessionId ?? defaultSessionIdResolver;
  }

  async handle(event: RawEvent, options: ChannelHandleOptions = {}): Promise<boolean> {
    const inbound = await this.channel.normalize(event);
    if (!inbound) return false;

    const injection = this.channel.promptInjection?.(inbound);
    const output = await this.agentLoop.runTurn({
      sessionId: this.resolveSessionId(inbound),
      userInput: inbound.text,
      promptInjections: injection ? [injection] : [],
      skills: this.options.skills,
      signal: options.signal,
      onEvent: (agentEvent) => this.channel.onAgentEvent?.(agentEvent, inbound),
    });
    await this.channel.send({
      conversationId: inbound.conversationId,
      text: output,
      replyToMessageId: inbound.messageId,
      metadata: { sourceChannel: inbound.channel },
    });
    return true;
  }
}
