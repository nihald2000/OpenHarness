import type { EventBus, EventEnvelope } from "../agent/deps.ts";

export class RedisEventBus implements EventBus {
  private listeners = new Set<{
    filter: { tenantId?: string; sessionId?: string };
    cb: (envelope: EventEnvelope) => void;
  }>();

  constructor(opts?: { redisUrl?: string }) {
    const url = opts?.redisUrl ?? process.env.REDIS_URL;
    if (!url) {
      throw new Error("RedisEventBus requires REDIS_URL to be configured (fail closed)");
    }
  }

  publish(envelope: EventEnvelope): void {
    for (const item of this.listeners) {
      if (item.filter.tenantId && item.filter.tenantId !== envelope.tenantId) continue;
      if (item.filter.sessionId && item.filter.sessionId !== envelope.sessionId) continue;
      item.cb(envelope);
    }
  }

  subscribe(
    filter: { tenantId?: string; sessionId?: string },
    listener: (envelope: EventEnvelope) => void
  ): () => void {
    const entry = { filter, cb: listener };
    this.listeners.add(entry);
    return () => {
      this.listeners.delete(entry);
    };
  }
}
