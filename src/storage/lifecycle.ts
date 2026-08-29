import { ManagedSessionStoreClosedError } from "./types.js";

type StorePhase = "open" | "closing" | "closed";

/** Admission gate shared by managed Store implementations. */
export class StoreLifecycle {
  private phase: StorePhase = "open";
  private activeOperations = 0;
  private idleWaiters: Array<() => void> = [];
  private closePromise?: Promise<void>;

  run<Result>(operation: () => Promise<Result>): Promise<Result> {
    if (this.phase !== "open") return Promise.reject(new ManagedSessionStoreClosedError());
    this.activeOperations += 1;
    let result: Promise<Result>;
    try {
      result = Promise.resolve(operation());
    } catch (error) {
      result = Promise.reject(error);
    }
    return result.finally(() => this.finishOperation());
  }

  close(closeResource: () => Promise<void>): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.phase = "closing";
    this.closePromise = (async () => {
      if (this.activeOperations > 0) {
        await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
      }
      try {
        await closeResource();
      } finally {
        this.phase = "closed";
      }
    })();
    return this.closePromise;
  }

  private finishOperation(): void {
    this.activeOperations -= 1;
    if (this.activeOperations !== 0) return;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const resolve of waiters) resolve();
  }
}
