import type { LockService } from "./contracts.ts";

export interface ReapableJobQueue {
  requeueExpired(now?: number): Promise<Array<{ id: string; status: string }>>;
  wakeDue(now?: number): Promise<string[]>;
}

/** Leader-elected durable queue maintenance loop for workers. */
export class PostgresJobReaper {
  private stopped = false;
  private loopPromise?: Promise<void>;
  constructor(
    private readonly queue: ReapableJobQueue,
    private readonly locks: LockService,
    private readonly options: { intervalMs?: number; leaderKey?: string; jitterMs?: number; onError?: (error: unknown) => void } = {},
  ) {}

  start() {
    if (!this.loopPromise) this.loopPromise = this.loop();
    return this.loopPromise;
  }

  stop() { this.stopped = true; }

  async runOnce() {
    let result: { expired: number; awakened: number } | undefined;
    const acquired = await this.locks.tryLeader(this.options.leaderKey ?? "job-reaper", async () => {
      const now = Date.now();
      const expired = await this.queue.requeueExpired(now);
      const awakened = await this.queue.wakeDue(now);
      result = { expired: expired.length, awakened: awakened.length };
    });
    return acquired ? result ?? { expired: 0, awakened: 0 } : undefined;
  }

  private async loop() {
    while (!this.stopped) {
      try { await this.runOnce(); }
      catch (error) { this.options.onError?.(error); }
      const interval = this.options.intervalMs ?? 10_000;
      const jitter = this.options.jitterMs ?? Math.floor(Math.random() * 1_000);
      await new Promise((resolve) => setTimeout(resolve, interval + jitter));
    }
  }
}
