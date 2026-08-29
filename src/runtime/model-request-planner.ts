import type {
  ModelCapabilities,
  ModelRequest,
  ToolDefinition,
} from "../model.js";
import { buildSystemPrompt } from "../prompt.js";
import type { DeepReadonly, Message } from "../session.js";

export interface ModelRequestPlannerConfig {
  compressionThreshold?: number;
  compressionThresholdTokens?: number;
}

export interface ModelBudget {
  compressionThresholdTokens?: number;
  maximumInputTokens?: number;
}

export interface PromptPlanningSnapshot {
  promptInjections: readonly string[];
  skillInstructions: readonly string[];
}

export interface ModelCapabilitySnapshot {
  resolved?: DeepReadonly<ModelCapabilities>;
  configured?: DeepReadonly<ModelCapabilities>;
}

export interface ModelRequestSnapshot {
  messages: readonly DeepReadonly<Message>[];
  tools: readonly DeepReadonly<ToolDefinition>[];
  systemPrompt: string;
  signal?: AbortSignal;
}

export interface PreviousCompressionSnapshot {
  compressed: boolean;
  messageCount: number;
  estimatedTokens?: number;
}

export interface ModelRequestPlanningSnapshot {
  request: ModelRequest;
  budget: DeepReadonly<ModelBudget>;
  estimatedTokens?: number;
  compressionAvailable: boolean;
  compressionPasses: number;
  previousCompression?: DeepReadonly<PreviousCompressionSnapshot>;
}

export type CompressionReason = "message_threshold" | "token_threshold" | "hard_limit";

export type ModelRequestDecision =
  | { kind: "ready"; request: ModelRequest }
  | {
      kind: "compress";
      reason: CompressionReason;
      baseline: {
        messageCount: number;
        estimatedTokens?: number;
      };
    }
  | { kind: "reject"; error: Error };

const MAX_AUTOMATIC_COMPRESSION_PASSES = 32;

/**
 * Pure prompt and model-budget policy. Provider I/O, token estimation, and
 * compression execution remain coordinated by AgentLoop.
 */
export class ModelRequestPlanner {
  private readonly compressionThreshold: number;
  private readonly compressionThresholdTokens?: number;
  private readonly hasExplicitMessageThreshold: boolean;

  constructor(config: DeepReadonly<ModelRequestPlannerConfig> = {}) {
    this.compressionThreshold = config.compressionThreshold ?? 100;
    this.compressionThresholdTokens = config.compressionThresholdTokens;
    this.hasExplicitMessageThreshold = config.compressionThreshold !== undefined;
    validateOptionalNonNegativeNumber(
      this.compressionThresholdTokens,
      "compressionThresholdTokens",
    );
  }

  buildPrompt(snapshot: DeepReadonly<PromptPlanningSnapshot>): string {
    return buildSystemPrompt([
      ...snapshot.promptInjections,
      ...snapshot.skillInstructions,
    ]);
  }

  resolveBudget(snapshot: DeepReadonly<ModelCapabilitySnapshot>): ModelBudget {
    const contextWindowTokens = readOptionalPositiveInteger(
      snapshot.resolved?.contextWindowTokens ?? snapshot.configured?.contextWindowTokens,
      "model contextWindowTokens",
    );
    const maxOutputTokens = readOptionalPositiveInteger(
      snapshot.resolved?.maxOutputTokens ?? snapshot.configured?.maxOutputTokens,
      "model maxOutputTokens",
    );
    if (contextWindowTokens === undefined) {
      return { compressionThresholdTokens: this.compressionThresholdTokens };
    }
    if (maxOutputTokens !== undefined && maxOutputTokens > contextWindowTokens) {
      throw new Error("model maxOutputTokens cannot exceed contextWindowTokens");
    }
    // ModelRequest does not yet carry a requested output limit. Keep a modest
    // reserve, capped by the provider's advertised output maximum when smaller.
    const defaultOutputReserve = Math.max(1, Math.ceil(contextWindowTokens * 0.1));
    const outputReserve = Math.min(
      maxOutputTokens ?? defaultOutputReserve,
      defaultOutputReserve,
      contextWindowTokens,
    );
    const maximumInputTokens = contextWindowTokens - outputReserve;
    return {
      compressionThresholdTokens: this.compressionThresholdTokens
        ?? Math.min(Math.floor(contextWindowTokens * 0.65), maximumInputTokens),
      maximumInputTokens,
    };
  }

  createRequest(snapshot: DeepReadonly<ModelRequestSnapshot>): ModelRequest {
    // The canonical data has already been detached and frozen by AgentLoop.
    // Freeze the envelope too so estimators and providers cannot rewrite it.
    return Object.freeze({
      messages: snapshot.messages as readonly Message[],
      tools: snapshot.tools as readonly ToolDefinition[],
      systemPrompt: snapshot.systemPrompt,
      signal: snapshot.signal,
    });
  }

  needsTokenEstimate(budget: DeepReadonly<ModelBudget>): boolean {
    return budget.compressionThresholdTokens !== undefined
      || budget.maximumInputTokens !== undefined;
  }

  normalizeTokenEstimate(estimate: number): number {
    if (!Number.isFinite(estimate) || estimate < 0) {
      throw new Error("Model request token estimate must be a finite non-negative number");
    }
    return Math.ceil(estimate);
  }

  plan(snapshot: DeepReadonly<ModelRequestPlanningSnapshot>): ModelRequestDecision {
    const { budget, request } = snapshot;
    const messageCount = request.messages.length;
    const reachedMessageThreshold = this.hasExplicitMessageThreshold
      && messageCount >= this.compressionThreshold;
    const needsEstimate = this.needsTokenEstimate(budget);

    if (!needsEstimate) {
      if (
        snapshot.compressionPasses === 0
        && reachedMessageThreshold
        && snapshot.compressionAvailable
      ) {
        return {
          kind: "compress",
          reason: "message_threshold",
          baseline: { messageCount },
        };
      }
      return { kind: "ready", request };
    }

    if (snapshot.estimatedTokens === undefined) {
      throw new Error("Model request planning requires a token estimate for this budget");
    }
    const estimatedTokens = this.normalizeTokenEstimate(snapshot.estimatedTokens);
    const reachedTokenThreshold = budget.compressionThresholdTokens !== undefined
      && estimatedTokens >= budget.compressionThresholdTokens;
    const exceedsHardLimit = budget.maximumInputTokens !== undefined
      && estimatedTokens > budget.maximumInputTokens;
    const canCompress = this.canCompress(snapshot, estimatedTokens);
    const shouldApplySoftCompression = snapshot.compressionPasses === 0
      && (reachedMessageThreshold || reachedTokenThreshold);

    if ((shouldApplySoftCompression || exceedsHardLimit) && canCompress) {
      return {
        kind: "compress",
        reason: reachedMessageThreshold
          ? "message_threshold"
          : reachedTokenThreshold
            ? "token_threshold"
            : "hard_limit",
        baseline: { messageCount, estimatedTokens },
      };
    }

    if (exceedsHardLimit) {
      return {
        kind: "reject",
        error: new Error(
          `Model request is estimated at ${estimatedTokens} input tokens, exceeding the `
          + `model input budget of ${budget.maximumInputTokens}.`,
        ),
      };
    }
    return { kind: "ready", request };
  }

  private canCompress(
    snapshot: DeepReadonly<ModelRequestPlanningSnapshot>,
    estimatedTokens: number,
  ): boolean {
    if (!snapshot.compressionAvailable
      || snapshot.compressionPasses >= MAX_AUTOMATIC_COMPRESSION_PASSES) {
      return false;
    }
    if (snapshot.compressionPasses === 0) return true;
    const previous = snapshot.previousCompression;
    return previous?.compressed === true
      && snapshot.request.messages.length < previous.messageCount
      && previous.estimatedTokens !== undefined
      && estimatedTokens < previous.estimatedTokens;
  }
}

function validateOptionalNonNegativeNumber(value: number | undefined, name: string): void {
  if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
    throw new Error(`${name} must be a non-negative number`);
  }
}

function readOptionalPositiveInteger(value: number | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}
