import type {
  ModelClient,
  ModelRequest,
  ModelResponse,
  ModelStreamEvent,
} from "../model.js";

export interface ProviderCodec<ProviderRequest, ProviderResponse, ProviderStreamEvent> {
  toProviderRequest(request: ModelRequest): ProviderRequest;
  fromProviderResponse(response: ProviderResponse): ModelResponse;
  fromProviderStreamEvent(event: ProviderStreamEvent): ModelStreamEvent | null;
}

export interface ProviderTransport<ProviderRequest, ProviderResponse, ProviderStreamEvent> {
  complete(request: ProviderRequest, signal?: AbortSignal): Promise<ProviderResponse>;
  stream?(
    request: ProviderRequest,
    signal?: AbortSignal,
  ): AsyncIterable<ProviderStreamEvent>;
}

/** Keeps provider payloads and message formats outside the AgentLoop. */
export class AdaptedModelClient<ProviderRequest, ProviderResponse, ProviderStreamEvent>
  implements ModelClient
{
  constructor(
    private readonly transport: ProviderTransport<
      ProviderRequest,
      ProviderResponse,
      ProviderStreamEvent
    >,
    private readonly codec: ProviderCodec<ProviderRequest, ProviderResponse, ProviderStreamEvent>,
  ) {}

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const response = await this.transport.complete(
      this.codec.toProviderRequest(request),
      request.signal,
    );
    return this.codec.fromProviderResponse(response);
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    if (!this.transport.stream) {
      yield { type: "done", response: await this.complete(request) };
      return;
    }
    for await (const event of this.transport.stream(
      this.codec.toProviderRequest(request),
      request.signal,
    )) {
      const normalized = this.codec.fromProviderStreamEvent(event);
      if (normalized) yield normalized;
    }
  }
}
