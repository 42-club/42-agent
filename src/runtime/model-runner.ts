import type { ModelClient, ModelRequest, ModelResponse, ToolCall } from "../model.js";
import { RetryPolicy, type RetryAttempt } from "./retry.js";

export interface ModelRunHooks {
  onTextDelta?: (delta: string) => void | Promise<void>;
  onRetry?: (attempt: RetryAttempt) => void | Promise<void>;
}

export class ModelRunner {
  constructor(
    private readonly model: ModelClient,
    private readonly retry = new RetryPolicy(),
  ) {}

  async run(request: ModelRequest, hooks: ModelRunHooks = {}): Promise<ModelResponse> {
    if (!this.model.stream) {
      return this.retry.execute(() => this.model.complete(request), request.signal, hooks.onRetry);
    }

    // A partially emitted stream cannot be retried transparently: doing so would
    // duplicate deltas already shown by a Channel. The provider may reconnect
    // internally before yielding its first event.
    let content = "";
    const toolCalls: ToolCall[] = [];
    let finalResponse: ModelResponse | undefined;
    for await (const event of this.model.stream(request)) {
      if (event.type === "text_delta") {
        content += event.delta;
        await hooks.onTextDelta?.(event.delta);
      } else if (event.type === "tool_call") {
        toolCalls.push(event.call);
      } else {
        finalResponse = event.response;
      }
    }
    return {
      content: finalResponse?.content ?? content,
      toolCalls: finalResponse?.toolCalls ?? toolCalls,
    };
  }
}
