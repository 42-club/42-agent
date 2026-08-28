import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { Tool, ToolContext } from "./base.js";

export interface BashDecision {
  allowed: boolean;
  requiresApproval: boolean;
  reason?: string;
}

export class BashPolicy {
  private readonly deletePatterns = [
    /(^|[;&|\n]\s*)(?:\S*\/)?rm(?:\s|$)/,
    /(^|[;&|\n]\s*)(?:\S*\/)?rmdir(?:\s|$)/,
    /(^|[;&|\n]\s*)(?:\S*\/)?unlink(?:\s|$)/,
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
    // Parsing an arbitrary shell program with regular expressions cannot prove
    // that it is harmless (an interpreter, npm script, or alias can perform the
    // same mutation). Every admitted shell execution therefore requires an
    // explicit host approval; the patterns above are only defense in depth.
    return {
      allowed: true,
      requiresApproval: true,
      reason: "Shell execution requires explicit approval",
    };
  }
}

export interface BashToolOptions {
  defaultCwd: string;
  policy?: BashPolicy;
  defaultTimeoutMs?: number;
  maxOutputBytes?: number;
  allowOutsideDefaultCwd?: boolean;
  env?: NodeJS.ProcessEnv;
}

export class BashTool implements Tool {
  readonly name = "bash";
  readonly description = "执行经过宿主明确批准的 Bash 命令。明显删除操作会被拒绝。";
  readonly executionPolicy = "exclusive" as const;
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
  private readonly maxOutputBytes: number;
  private readonly allowOutsideDefaultCwd: boolean;
  private readonly env: NodeJS.ProcessEnv | undefined;

  constructor(options: BashToolOptions) {
    this.defaultCwd = resolve(options.defaultCwd);
    this.policy = options.policy ?? new BashPolicy();
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 60_000;
    this.maxOutputBytes = options.maxOutputBytes ?? 1_000_000;
    this.allowOutsideDefaultCwd = options.allowOutsideDefaultCwd ?? false;
    this.env = options.env;
  }

  async execute(arguments_: Record<string, unknown>, context: ToolContext): Promise<unknown> {
    const command = String(arguments_.command ?? "");
    const decision = this.policy.evaluate(command);
    if (!decision.allowed) throw new Error(decision.reason);
    const configuredCwd = resolve(this.defaultCwd, String(arguments_.cwd ?? "."));
    const [actualDefaultCwd, actualCwd] = await Promise.all([
      realpath(this.defaultCwd),
      realpath(configuredCwd),
    ]);
    const relativeCwd = relative(actualDefaultCwd, actualCwd);
    if (!this.allowOutsideDefaultCwd
      && (relativeCwd === ".." || relativeCwd.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
        || isAbsolute(relativeCwd))) {
      throw new Error("Command cwd escapes the configured default directory");
    }
    const approved = await waitForApproval(
      () => context.requestApproval(
        `即将在 cwd ${actualCwd} 执行 Bash 命令：${command}\n是否允许执行？`,
      ),
      context.signal,
    );
    if (!approved) return { approved: false, executed: false };
    return runBash(
      command,
      actualCwd,
      Number(arguments_.timeoutMs ?? this.defaultTimeoutMs),
      this.maxOutputBytes,
      context.signal,
      this.env,
    );
  }
}

async function waitForApproval(
  requestApproval: () => Promise<boolean>,
  signal?: AbortSignal,
): Promise<boolean> {
  if (!signal) return requestApproval();
  if (signal.aborted) throw abortReason(signal);

  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    // Avoid missing an abort that happened between the pre-check and listener registration.
    if (signal.aborted) onAbort();
  });
  const pendingApproval = Promise.resolve().then(() => {
    if (signal.aborted) throw abortReason(signal);
    return requestApproval();
  });

  try {
    return await Promise.race([pendingApproval, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
    // The host approval UI cannot necessarily be cancelled. Keep a rejection
    // arriving after abort from becoming an unhandled promise rejection.
    void pendingApproval.catch(() => undefined);
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Aborted", "AbortError");
}

async function runBash(
  command: string,
  cwd: string,
  timeoutMs: number,
  maxOutputBytes: number,
  signal?: AbortSignal,
  env?: NodeJS.ProcessEnv,
): Promise<unknown> {
  return new Promise((resolvePromise, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }
    const child = spawn("/bin/bash", ["-lc", command], {
      cwd,
      detached: true,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let settled = false;
    const finish = (error?: unknown, result?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (error !== undefined) reject(error);
      else resolvePromise(result);
    };
    const collect = (target: "stdout" | "stderr", chunk: string) => {
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > maxOutputBytes) {
        killProcessGroup(child.pid);
        finish(new Error(`Command output exceeded ${maxOutputBytes} bytes`));
        return;
      }
      if (target === "stdout") stdout += chunk;
      else stderr += chunk;
    };
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => collect("stdout", chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => collect("stderr", chunk));
    const timer = setTimeout(() => {
      killProcessGroup(child.pid);
      finish(new Error(`Command timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    const abort = () => {
      killProcessGroup(child.pid);
      finish(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    child.on("error", (error) => {
      finish(error);
    });
    child.on("close", (exitCode) => {
      finish(undefined, { approved: true, executed: true, exitCode, stdout, stderr });
    });
  });
}

function killProcessGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // The process may already have exited between the timeout/abort and kill.
  }
}
