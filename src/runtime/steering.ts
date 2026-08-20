export class SteeringQueue {
  private readonly queues = new Map<string, string[]>();

  enqueue(sessionId: string, message: string): void {
    const queue = this.queues.get(sessionId) ?? [];
    queue.push(message);
    this.queues.set(sessionId, queue);
  }

  drain(sessionId: string): string[] {
    const queue = this.queues.get(sessionId) ?? [];
    this.queues.delete(sessionId);
    return queue;
  }
}
