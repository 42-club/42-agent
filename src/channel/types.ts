export interface ChannelInboundMessage {
  channel: string;
  conversationId: string;
  senderId: string;
  text: string;
  messageId?: string;
  metadata?: Record<string, unknown>;
}

export interface ChannelOutboundMessage {
  conversationId: string;
  text: string;
  replyToMessageId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * A channel only translates transport-specific events and output. It must not
 * keep conversation history; AgentRuntime owns lifecycle and AgentLoop's
 * SessionStore is the source of truth.
 */
export interface ChannelAdapter<RawEvent = unknown> {
  readonly name: string;
  normalize(event: RawEvent): Promise<ChannelInboundMessage | null>;
  send(message: ChannelOutboundMessage): Promise<void>;
  promptInjection?(message: ChannelInboundMessage): string | undefined;
  onAgentEvent?(event: AgentLoopEvent, message: ChannelInboundMessage): Promise<void>;
}

export type SessionIdResolver = (message: ChannelInboundMessage) => string;

export const defaultSessionIdResolver: SessionIdResolver = (message) =>
  `${message.channel}:${message.conversationId}`;
import type { AgentLoopEvent } from "../runtime/events.js";
