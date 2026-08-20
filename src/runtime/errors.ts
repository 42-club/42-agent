export interface RuntimeErrorInfo {
  code: string;
  message: string;
  retryable: boolean;
  statusCode?: number;
}

export class RuntimeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
    readonly statusCode?: number,
  ) {
    super(message);
    this.name = "RuntimeError";
  }
}

export function normalizeRuntimeError(error: unknown): RuntimeErrorInfo {
  if (error instanceof RuntimeError) {
    return { code: error.code, message: error.message, retryable: error.retryable, statusCode: error.statusCode };
  }
  const message = error instanceof Error ? error.message : String(error);
  const status = Number(/\b(400|401|403|404|408|409|429|500|502|503|504)\b/.exec(message)?.[1]);
  const retryable = status === 408 || status === 429 || [500, 502, 503, 504].includes(status)
    || /ECONNRESET|ETIMEDOUT|fetch failed|network|transient/i.test(message);
  return { code: status ? `HTTP_${status}` : "RUNTIME_ERROR", message, retryable, statusCode: status || undefined };
}
