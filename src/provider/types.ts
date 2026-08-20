import type { Message } from "../session.js";

/** Provider-specific message conversion stays outside AgentLoop. */
export interface MessageConverter<ProviderMessage> {
  toProvider(messages: readonly Message[], systemPrompt: string): readonly ProviderMessage[];
}

export interface ModelProvider<TClient> {
  readonly id: string;
  createClient(config: Record<string, unknown>): TClient;
}

export class ModelProviderRegistry<TClient> {
  private readonly providers = new Map<string, ModelProvider<TClient>>();

  register(provider: ModelProvider<TClient>): void {
    if (this.providers.has(provider.id)) throw new Error(`Provider already registered: ${provider.id}`);
    this.providers.set(provider.id, provider);
  }

  create(providerId: string, config: Record<string, unknown> = {}): TClient {
    const provider = this.providers.get(providerId);
    if (!provider) throw new Error(`Unknown provider: ${providerId}`);
    return provider.createClient(config);
  }
}
