import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { AgentLoop } from "../agent-loop.js";
import type { AgentLoopEvent } from "../runtime/events.js";

export interface RuntimeServerOptions {
  host?: string;
  port?: number;
  allowedOrigin?: string;
}

export interface TurnRequest {
  sessionId: string;
  userInput: string;
  promptInjections?: string[];
  skills?: string[];
}

export function createAgentRuntimeHttpServer(
  loop: AgentLoop,
  options: RuntimeServerOptions = {},
) {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 8787;
  const server = createServer(async (request, response) => {
    setCors(response, options.allowedOrigin ?? "*");
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

    const controller = new AbortController();
    response.on("close", () => {
      if (!response.writableEnded) controller.abort(new DOMException("Client disconnected", "AbortError"));
    });
    try {
      const body = await readJson<TurnRequest>(request);
      validateTurn(body);
      response.writeHead(200, {
        "content-type": "application/x-ndjson; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
      });
      const write = (payload: unknown) => response.write(`${JSON.stringify(payload)}\n`);
      const content = await loop.runTurn({
        ...body,
        signal: controller.signal,
        onEvent: (event: AgentLoopEvent) => {
          write({ type: "event", event });
        },
      });
      write({ type: "result", content });
      response.end();
    } catch (error) {
      const payload = { type: "error", message: error instanceof Error ? error.message : String(error) };
      if (response.headersSent) {
        response.end(`${JSON.stringify(payload)}\n`);
      } else {
        sendJson(response, 400, payload);
      }
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
    close: () => new Promise<void>((resolvePromise) => server.close(() => resolvePromise())),
  };
}

function validateTurn(body: TurnRequest): void {
  if (!body || typeof body.sessionId !== "string" || typeof body.userInput !== "string") {
    throw new Error("sessionId and userInput are required");
  }
}

async function readJson<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function setCors(response: ServerResponse, origin: string): void {
  response.setHeader("access-control-allow-origin", origin);
  response.setHeader("access-control-allow-headers", "content-type");
  response.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
}
