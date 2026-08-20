import { spawn } from "node:child_process";
import { resolve } from "node:path";
import type { Tool, ToolContext } from "./base.js";

export interface BashDecision {
  allowed: boolean;
  requiresApproval: boolean;
  reason?: string;
}

export class BashPolicy {
  private readonly deletePatterns = [
    /(^|[;&|]\s*)rm(?:\s|$)/,
    /(^|[;&|]\s*)rmdir(?:\s|$)/,
    /(^|[;&|]\s*)unlink(?:\s|$)/,
    /\bfind\b[^\n]*\s-delete\b/,
    /\b(?:DELETE\s+FROM|DROP\s+(?:TABLE|DATABASE|SCHEMA))\b/i,
  ];
  private readonly approvalPatterns = [
    /(^|\s)(?:sudo|chmod|chown)(?:\s|$)/,
    /\bgit\s+push\b[^\n]*(?:--force|-f)\b/,
    /\bgit\s+reset\s+--hard\b/,
    /(^|[;&|]\s*)mv(?:\s|$)/,
    /(?:^|[^>])>{1}(?!>)\s*[^&]/,
    /\b(?:TRUNCATE|ALTER)\b/i,
  ];

  evaluate(command: string): BashDecision {
    if (!command.trim()) return { allowed: false, requiresApproval: false, reason: "Empty command" };
    if (this.deletePatterns.some((pattern) => pattern.test(command))) {
      return { allowed: false, requiresApproval: false, reason: "Delete operations are not allowed" };
    }
    if (this.approvalPatterns.some((pattern) => pattern.test(command))) {
      return { allowed: true, requiresApproval: true, reason: "Potentially irreversible operation" };
    }
    return { allowed: true, requiresApproval: false };
  }
}

export interface BashToolOptions {
  defaultCwd: string;
  policy?: BashPolicy;
  defaultTimeoutMs?: number;
}

export class BashTool implements Tool {
  readonly name = "bash";
  readonly description = "执行 Bash 命令。删除操作被禁止；潜在不可逆操作必须先获得用户批准。";
  readonly inputSchema = {
    type: "object",
    properties: {
      command: { type: "string" },
      cwd: { type: "string" },
      timeoutMs: { type: "number", minimum: 100, maximum: 300_000 },
    },
    required: ["command"],
    additionalProperties: false,
  };
  private readonly policy: BashPolicy;
  private readonly defaultCwd: string;
  private readonly defaultTimeoutMs: number;

  constructor(options: BashToolOptions) {
    this.defaultCwd = resolve(options.defaultCwd);
    this.policy = options.policy ?? new BashPolicy();
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 60_000;
  }

  async execute(arguments_: Record<string, unknown>, context: ToolContext): Promise<unknown> {
    const command = String(arguments_.command ?? "");
    const decision = this.policy.evaluate(command);
    if (!decision.allowed) throw new Error(decision.reason);
    if (decision.requiresApproval) {
      const approved = await context.requestApproval(
        `命令可能产生不可逆影响：${command}\n是否允许执行？`,
      );
      if (!approved) return { approved: false, executed: false };
    }
    return runBash(
      command,
      resolve(String(arguments_.cwd ?? this.defaultCwd)),
      Number(arguments_.timeoutMs ?? this.defaultTimeoutMs),
      context.signal,
    );
  }
}

async function runBash(
  command: string,
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<unknown> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("/bin/bash", ["-lc", command], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Command timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    const abort = () => {
      child.kill("SIGKILL");
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    child.on("error", (error) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(error);
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      resolvePromise({ approved: true, executed: true, exitCode, stdout, stderr });
    });
  });
}
