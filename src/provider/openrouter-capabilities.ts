import type { ModelCapabilities } from "../model.js";

export interface OpenRouterCapabilitiesResolverOptions {
  apiKey: string;
  model: string;
  baseUrl: string;
  fetch: typeof fetch;
  contextWindowTokens?: number;
  maxOutputTokens?: number;
}

/** Resolves the limits advertised by OpenRouter's model metadata endpoint. */
export class OpenRouterCapabilitiesResolver {
  private resolved?: ModelCapabilities;

  constructor(private readonly options: OpenRouterCapabilitiesResolverOptions) {
    validateOptionalTokenLimit(options.contextWindowTokens, "contextWindowTokens");
    validateOptionalTokenLimit(options.maxOutputTokens, "maxOutputTokens");
    assertCompatibleLimits(options.contextWindowTokens, options.maxOutputTokens);
    if (options.contextWindowTokens !== undefined) {
      this.resolved = Object.freeze({
        contextWindowTokens: options.contextWindowTokens,
        ...(options.maxOutputTokens === undefined
          ? {}
          : { maxOutputTokens: options.maxOutputTokens }),
      });
    }
  }

  get capabilities(): ModelCapabilities | undefined {
    return this.resolved;
  }

  async getCapabilities(signal?: AbortSignal): Promise<ModelCapabilities> {
    throwIfSignalAborted(signal);
    if (this.resolved) return this.resolved;
    const response = await this.options.fetch(this.metadataUrl(), {
      headers: { authorization: `Bearer ${this.options.apiKey}` },
      signal,
    });
    throwIfSignalAborted(signal);
    if (!response.ok) {
      const details = (await response.text()).slice(0, 500);
      throwIfSignalAborted(signal);
      throw new Error(
        `OpenRouter model metadata ${response.status}: ${details}. ` +
        "Set contextWindowTokens explicitly if this endpoint is unavailable.",
      );
    }
    const body = await response.json() as {
      data?: {
        context_length?: unknown;
        top_provider?: { max_completion_tokens?: unknown } | null;
      };
    };
    throwIfSignalAborted(signal);
    const contextWindowTokens = readTokenLimit(
      body.data?.context_length,
      "OpenRouter model metadata context_length",
    );
    const advertisedMaxOutput = body.data?.top_provider?.max_completion_tokens;
    const maxOutputTokens = this.options.maxOutputTokens
      ?? (advertisedMaxOutput === null || advertisedMaxOutput === undefined
        ? undefined
        : readTokenLimit(
            advertisedMaxOutput,
            "OpenRouter model metadata top_provider.max_completion_tokens",
          ));
    assertCompatibleLimits(contextWindowTokens, maxOutputTokens);
    this.resolved = Object.freeze({
      contextWindowTokens,
      ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    });
    return this.resolved;
  }

  private metadataUrl(): string {
    const path = this.options.model.split("/").map(encodeURIComponent).join("/");
    return `${this.options.baseUrl}/model/${path}`;
  }
}

function assertCompatibleLimits(
  contextWindowTokens: number | undefined,
  maxOutputTokens: number | undefined,
): void {
  if (
    contextWindowTokens !== undefined
    && maxOutputTokens !== undefined
    && maxOutputTokens > contextWindowTokens
  ) {
    throw new Error("maxOutputTokens cannot exceed contextWindowTokens");
  }
}

function validateOptionalTokenLimit(value: number | undefined, name: string): void {
  if (value === undefined) return;
  readTokenLimit(value, name);
}

function readTokenLimit(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function throwIfSignalAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}
