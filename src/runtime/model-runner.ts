import {
  supportsModelStreaming,
  type ModelClient,
  type ModelRequest,
  type ModelResponse,
  type ToolCall,
} from "../model.js";
import { RetryPolicy, throwIfAborted, type RetryAttempt } from "./retry.js";

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
    if (!supportsModelStreaming(this.model)) {
      return this.retry.execute(() => this.model.complete(request), request.signal, hooks.onRetry);
    }

    throwIfAborted(request.signal);
    // A partially emitted stream cannot be retried transparently: doing so would
    // duplicate deltas already shown by a Channel. The provider may reconnect
    // internally before yielding its first event.
    let content = "";
    const toolCalls: ToolCall[] = [];
    let finalResponse: ModelResponse | undefined;
    let completed = false;
    for await (const event of this.model.stream(request)) {
      throwIfAborted(request.signal);
      if (event.type === "text_delta") {
        content += event.delta;
        await hooks.onTextDelta?.(event.delta);
      } else if (event.type === "tool_call") {
        toolCalls.push(event.call);
      } else if (event.type === "done") {
        finalResponse = event.response;
        completed = true;
        // `done` is terminal. IteratorClose gives the provider a chance to
        // release transport resources without consuming any later events.
        break;
      } else {
        const type = (event as { type?: unknown }).type;
        throw new Error(`Unknown model stream event type: ${String(type)}`);
      }
    }
    if (!completed) {
      throw new Error("Model stream ended before a done event");
    }
    throwIfAborted(request.signal);
    return {
      content: finalResponse?.content ?? content,
      toolCalls: finalResponse?.toolCalls ?? toolCalls,
    };
  }
}
