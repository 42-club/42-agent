export class SteeringQueue {
  private readonly activeRuns = new Map<string, string>();
  private readonly queues = new Map<string, string[]>();

  begin(sessionId: string, runId: string): void {
    this.activeRuns.set(sessionId, runId);
    this.queues.delete(runKey(sessionId, runId));
  }

  enqueue(sessionId: string, message: string): boolean {
    const runId = this.activeRuns.get(sessionId);
    if (!runId) return false;
    const key = runKey(sessionId, runId);
    const queue = this.queues.get(key) ?? [];
    queue.push(message);
    this.queues.set(key, queue);
    return true;
  }

  drain(sessionId: string, runId: string): string[] {
    if (this.activeRuns.get(sessionId) !== runId) return [];
    const key = runKey(sessionId, runId);
    const queue = this.queues.get(key) ?? [];
    this.queues.delete(key);
    return queue;
  }

  /** Drain the final barrier, closing admission atomically when it is empty. */
  drainFinal(sessionId: string, runId: string): string[] {
    const messages = this.drain(sessionId, runId);
    if (messages.length === 0) this.end(sessionId, runId);
    return messages;
  }

  end(sessionId: string, runId: string): void {
    this.queues.delete(runKey(sessionId, runId));
    if (this.activeRuns.get(sessionId) === runId) this.activeRuns.delete(sessionId);
  }

  clear(sessionId: string): void {
    const runId = this.activeRuns.get(sessionId);
    if (runId) this.queues.delete(runKey(sessionId, runId));
    this.activeRuns.delete(sessionId);
  }
}

function runKey(sessionId: string, runId: string): string {
  return `${sessionId.length}:${sessionId}${runId}`;
}
