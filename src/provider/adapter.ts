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
  readonly stream?: (request: ModelRequest) => AsyncIterable<ModelStreamEvent>;

  constructor(
    private readonly transport: ProviderTransport<
      ProviderRequest,
      ProviderResponse,
      ProviderStreamEvent
    >,
    private readonly codec: ProviderCodec<ProviderRequest, ProviderResponse, ProviderStreamEvent>,
  ) {
    // Keep `stream` genuinely optional. ModelRunner uses its presence to decide
    // whether a call is streaming and therefore whether transparent retries are
    // safe. Installing a fallback stream for a non-streaming transport silently
    // disabled the normal RetryPolicy.
    if (transport.stream) {
      this.stream = (request) => this.streamTransport(request);
    }
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const response = await this.transport.complete(
      this.codec.toProviderRequest(request),
      request.signal,
    );
    return this.codec.fromProviderResponse(response);
  }

  private async *streamTransport(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    const stream = this.transport.stream;
    if (!stream) return;
    for await (const event of stream.call(this.transport,
      this.codec.toProviderRequest(request),
      request.signal,
    )) {
      const normalized = this.codec.fromProviderStreamEvent(event);
      if (normalized) yield normalized;
    }
  }
}
