import type { CancelBus } from "./contracts.ts";

/** Local cancellation fan-out; distributed mode will publish these requests across workers. */
export class InProcessCancelBus implements CancelBus {
  private readonly listeners = new Map<string, Set<() => void>>();

  async request(sessionId: string) {
    for (const listener of this.listeners.get(sessionId) ?? []) listener();
  }

  onCancel(sessionId: string, listener: () => void) {
    let listeners = this.listeners.get(sessionId);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(sessionId, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners!.delete(listener);
      if (listeners!.size === 0) this.listeners.delete(sessionId);
    };
  }
}
