import type { Sql } from "postgres";
import type { EventBus, LockService } from "./contracts.ts";
import { relayOutboxBatch } from "./postgres-outbox.ts";

/** Periodically drains committed outbox rows while holding a cluster leader lock. */
export class PostgresOutboxPump<Event = unknown> {
  private stopped = false;
  private loopPromise?: Promise<void>;
  constructor(
    private readonly sql: Sql,
    private readonly bus: EventBus<Event>,
    private readonly locks: LockService,
    private readonly options: { intervalMs?: number; batchSize?: number; leaderKey?: string; onError?: (error: unknown) => void } = {},
  ) {}

  start() {
    if (!this.loopPromise) this.loopPromise = this.loop();
    return this.loopPromise;
  }
  stop() { this.stopped = true; }

  async runOnce() {
    let count = 0;
    const acquired = await this.locks.tryLeader(this.options.leaderKey ?? "event-outbox", async () => {
      while (!this.stopped) {
        const batch = await relayOutboxBatch(this.sql, this.bus, this.options.batchSize ?? 250);
        count += batch;
        if (batch < (this.options.batchSize ?? 250)) break;
      }
    });
    return acquired ? count : undefined;
  }

  private async loop() {
    while (!this.stopped) {
      try { await this.runOnce(); }
      catch (error) { this.options.onError?.(error); }
      if (!this.stopped) await new Promise((resolve) => setTimeout(resolve, this.options.intervalMs ?? 500));
    }
  }
}
