import { normalizeRuntimeError, type RuntimeErrorInfo } from "./errors.js";

export interface RetryPolicyOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  shouldRetry?: (error: unknown) => boolean;
}

export interface RetryAttempt {
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  error: RuntimeErrorInfo;
}

export class RetryPolicy {
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly shouldRetry: (error: unknown) => boolean;

  constructor(options: RetryPolicyOptions = {}) {
    this.maxAttempts = options.maxAttempts ?? 5;
    this.baseDelayMs = options.baseDelayMs ?? 250;
    this.shouldRetry = options.shouldRetry ?? ((error) => normalizeRuntimeError(error).retryable);
  }

  async execute<T>(operation: () => Promise<T>, signal?: AbortSignal, onRetry?: (attempt: RetryAttempt) => void | Promise<void>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      throwIfAborted(signal);
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        if (attempt === this.maxAttempts || !this.shouldRetry(error)) throw error;
        const base = this.baseDelayMs * 2 ** (attempt - 1);
        const delayMs = Math.round(base * (0.8 + Math.random() * 0.4));
        await onRetry?.({ attempt: attempt + 1, maxAttempts: this.maxAttempts, delayMs, error: normalizeRuntimeError(error) });
        await abortableDelay(delayMs, signal);
      }
    }
    throw lastError;
  }
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
}

function abortableDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal?.removeEventListener("abort", aborted);
    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const aborted = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(finish, delayMs);
    signal?.addEventListener("abort", aborted, { once: true });
    // Do not miss an abort raised by a synchronous retry observer before this
    // delay was created, or one racing listener registration.
    if (signal?.aborted) aborted();
  });
}
