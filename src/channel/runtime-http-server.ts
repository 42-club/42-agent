import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { AgentRuntime } from "../agent-runtime.js";
import type { AgentLoopEvent } from "../runtime/events.js";
import { assertValidSessionId } from "../session.js";

export interface RuntimeServerOptions {
  host?: string;
  port?: number;
  allowedOrigin?: string;
  maxBodyBytes?: number;
  /** Maximum encoded progress-event bytes waiting on response backpressure. */
  maxEventBufferBytes?: number;
}

export interface TurnRequest {
  sessionId: string;
  userInput: string;
  promptInjections?: string[];
  skills?: string[];
  tools?: string[];
  metadata?: Record<string, unknown>;
}

export function createAgentRuntimeHttpServer(
  runtime: AgentRuntime,
  options: RuntimeServerOptions = {},
) {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 8787;
  const maxBodyBytes = options.maxBodyBytes ?? 1_048_576;
  const maxEventBufferBytes = options.maxEventBufferBytes ?? 1_048_576;
  const activeRequests = new Set<AbortController>();
  let closing = false;
  const server = createServer(async (request, response) => {
    const origin = request.headers.origin;
    if (origin !== undefined && (
      typeof origin !== "string" || origin !== options.allowedOrigin
    )) {
      sendJson(response, 403, { error: "OriginNotAllowed" });
      return;
    }
    if (typeof origin === "string") setCors(response, origin);
    if (request.method === "OPTIONS") {
      response.writeHead(204).end();
      return;
    }
    if (request.method === "GET" && request.url === "/health") {
      sendJson(response, 200, { ok: true });
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/turn") {
      sendJson(response, 404, { error: "NotFound" });
      return;
    }
    const contentType = request.headers["content-type"];
    if (typeof contentType !== "string"
      || !/^application\/json(?:\s*;|$)/i.test(contentType)) {
      sendJson(response, 415, { error: "ContentTypeMustBeApplicationJson" });
      return;
    }

    const controller = new AbortController();
    activeRequests.add(controller);
    response.on("close", () => {
      if (!response.writableEnded) controller.abort(new DOMException("Client disconnected", "AbortError"));
    });
    try {
      const body = await readJson<TurnRequest>(request, maxBodyBytes, controller.signal);
      validateTurn(body);
      response.writeHead(200, {
        "content-type": "application/x-ndjson; charset=utf-8",
        "cache-control": "no-cache, no-transform",
      });
      const writer = new BoundedNdjsonWriter(
        response,
        controller,
        Math.max(1, maxEventBufferBytes),
      );
      const result = await runtime.prompt({
        sessionId: body.sessionId,
        content: [{ type: "text", text: body.userInput }],
        createIfMissing: true,
        promptInjections: body.promptInjections,
        skills: body.skills,
        tools: body.tools,
        metadata: body.metadata,
        signal: controller.signal,
        onEvent: (event: AgentLoopEvent) => writer.enqueue({ type: "event", event }),
      });
      await writer.write({
        type: "result",
        sessionId: result.sessionId,
        runId: result.runId,
        stopReason: result.stopReason,
        content: result.content.map((part) => part.text).join(""),
      });
      response.end();
    } catch (error) {
      const payload = { type: "error", message: error instanceof Error ? error.message : String(error) };
      if (response.destroyed) {
        // A disconnected or backpressured client already owns this failure.
      } else if (response.headersSent) {
        response.end(`${JSON.stringify(payload)}\n`);
      } else {
        sendJson(response, 400, payload);
      }
    } finally {
      activeRequests.delete(controller);
      if (closing) server.closeIdleConnections();
    }
  });

  return {
    server,
    listen: () =>
      new Promise<{ host: string; port: number }>((resolvePromise, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          const address = server.address() as AddressInfo;
          resolvePromise({ host, port: address.port });
        });
      }),
    close: () => {
      closing = true;
      for (const controller of activeRequests) {
        controller.abort(new DOMException("HTTP server closed", "AbortError"));
      }
      return new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    },
  };
}

function validateTurn(body: TurnRequest): void {
  if (!body || typeof body.sessionId !== "string" || typeof body.userInput !== "string") {
    throw new Error("sessionId and userInput are required");
  }
  assertValidSessionId(body.sessionId);
  for (const [name, value] of [
    ["promptInjections", body.promptInjections],
    ["skills", body.skills],
    ["tools", body.tools],
  ] as const) {
    if (value !== undefined && (!Array.isArray(value)
      || !value.every((item) => typeof item === "string"))) {
      throw new Error(`${name} must be an array of strings`);
    }
  }
  if (body.metadata !== undefined
    && (typeof body.metadata !== "object" || body.metadata === null || Array.isArray(body.metadata))) {
    throw new Error("metadata must be an object");
  }
}

async function readJson<T>(
  request: IncomingMessage,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) throw abortReason(signal);
  const chunks: Buffer[] = [];
  let bytes = 0;
  let tooLarge = false;
  const abort = () => request.destroy(abortReason(signal));
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  try {
    for await (const chunk of request) {
      const buffer = Buffer.from(chunk);
      bytes += buffer.byteLength;
      if (bytes > maxBytes) {
        tooLarge = true;
        continue;
      }
      chunks.push(buffer);
    }
    if (signal?.aborted) throw abortReason(signal);
    if (tooLarge) throw new Error(`Request body exceeds ${maxBytes} bytes`);
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}

function abortReason(signal?: AbortSignal): Error {
  return signal?.reason instanceof Error
    ? signal.reason
    : new DOMException("Aborted", "AbortError");
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function setCors(response: ServerResponse, origin?: string): void {
  if (!origin) return;
  response.setHeader("access-control-allow-origin", origin);
  response.setHeader("access-control-allow-headers", "content-type");
  response.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
}

function waitForDrain(response: ServerResponse): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const cleanup = () => {
      response.off("drain", drained);
      response.off("close", closed);
      response.off("error", failed);
    };
    const drained = () => {
      cleanup();
      resolvePromise();
    };
    const closed = () => {
      cleanup();
      reject(new DOMException("Client disconnected", "AbortError"));
    };
    const failed = (error: Error) => {
      cleanup();
      reject(error);
    };
    response.once("drain", drained);
    response.once("close", closed);
    response.once("error", failed);
  });
}

class BoundedNdjsonWriter {
  private tail: Promise<void> = Promise.resolve();
  private queuedBytes = 0;
  private failure: unknown;

  constructor(
    private readonly response: ServerResponse,
    private readonly controller: AbortController,
    private readonly maxQueuedBytes: number,
  ) {}

  enqueue(payload: unknown): void {
    if (this.failure !== undefined) return;
    let line: string;
    try {
      line = encodeNdjson(payload);
    } catch (error) {
      this.fail(error);
      return;
    }
    const bytes = Buffer.byteLength(line);
    if (this.queuedBytes + bytes > this.maxQueuedBytes) {
      this.fail(new Error(`Progress event buffer exceeds ${this.maxQueuedBytes} bytes`));
      return;
    }

    this.queuedBytes += bytes;
    const pending = this.tail.then(() => writeLine(this.response, line));
    this.tail = pending
      .catch((error: unknown) => this.fail(error))
      .then(() => {
        this.queuedBytes -= bytes;
      });
  }

  async write(payload: unknown): Promise<void> {
    await this.tail;
    if (this.failure !== undefined) throw this.failure;
    await writeLine(this.response, encodeNdjson(payload));
  }

  private fail(error: unknown): void {
    if (this.failure !== undefined) return;
    this.failure = error;
    this.controller.abort(error);
    this.response.destroy(error instanceof Error ? error : undefined);
  }
}

function encodeNdjson(payload: unknown): string {
  return `${JSON.stringify(payload)}\n`;
}

async function writeLine(response: ServerResponse, line: string): Promise<void> {
  if (response.destroyed || response.writableEnded) {
    throw new DOMException("Client disconnected", "AbortError");
  }
  if (!response.write(line)) await waitForDrain(response);
}
