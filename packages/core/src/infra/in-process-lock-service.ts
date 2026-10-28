import type { LockService } from "./contracts.ts";

/** Per-key process-local mutexes for read-modify-write operations and local leadership. */
export class InProcessLockService implements LockService {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly leaders = new Set<string>();

  async withLock<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
    if (!key || !Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error("lock key and positive ttlMs are required");
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => gate);
    this.tails.set(key, tail);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }

  async tryLeader(name: string, fn: () => Promise<void>): Promise<boolean> {
    if (!name || this.leaders.has(name)) return false;
    this.leaders.add(name);
    try {
      await fn();
      return true;
    } finally {
      this.leaders.delete(name);
    }
  }
}

export const localLockService = new InProcessLockService();
