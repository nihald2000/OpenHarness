import Redis from "ioredis";
import type { CancelBus, EventBus, EventEnvelope } from "./contracts.ts";

const EVENT_CHANNEL = "openharness:events:v1";

/** Cross-process event fan-out. Durable replay remains the StateStore's job. */
export class RedisEventBus<Event = unknown> implements EventBus<Event> {
  private readonly listeners = new Set<{ filter: { sessionId?: string; tenantId: string; userId?: string }; listener: (event: EventEnvelope<Event>) => void }>();
  private readonly onMessage: (channel: string, message: string) => void;

  constructor(private readonly publisher: Redis, private readonly subscriber: Redis, private readonly ownsClients = false) {
    this.onMessage = (channel, message) => {
      if (channel !== EVENT_CHANNEL) return;
      let envelope: EventEnvelope<Event>;
      try { envelope = JSON.parse(message) as EventEnvelope<Event>; } catch { return; }
      for (const item of this.listeners) {
        if (item.filter.tenantId !== envelope.tenantId) continue;
        if (item.filter.sessionId && item.filter.sessionId !== envelope.sessionId) continue;
        try { item.listener(envelope); } catch { /* one SSE client must not break fan-out */ }
      }
    };
    subscriber.on("message", this.onMessage);
    void subscriber.subscribe(EVENT_CHANNEL);
  }

  static connect<Event = unknown>(url: string, options: Redis.RedisOptions = {}) {
    return new RedisEventBus<Event>(new Redis(url, options), new Redis(url, options), true);
  }

  async publish(envelope: EventEnvelope<Event>) {
    await this.publisher.publish(EVENT_CHANNEL, JSON.stringify(envelope));
  }
  publishDelta(envelope: EventEnvelope<Event>) { void this.publish(envelope).catch(() => undefined); }
  subscribe(filter: { sessionId?: string; tenantId: string; userId?: string }, listener: (envelope: EventEnvelope<Event>) => void) {
    const entry = { filter, listener };
    this.listeners.add(entry);
    return () => this.listeners.delete(entry);
  }
  async close() {
    this.subscriber.off("message", this.onMessage);
    if (this.ownsClients) await Promise.all([this.publisher.quit(), this.subscriber.quit()]);
  }
}

/** Redis pub/sub cancellation is advisory; workers must also check durable job state. */
export class RedisCancelBus implements CancelBus {
  private readonly listeners = new Map<string, Set<() => void>>();
  private readonly onMessage: (channel: string) => void;
  constructor(private readonly publisher: Redis, private readonly subscriber: Redis, private readonly ownsClients = false) {
    this.onMessage = (channel) => {
      const sessionId = channel.slice("openharness:cancel:".length);
      for (const listener of this.listeners.get(sessionId) ?? []) { try { listener(); } catch { /* isolate listeners */ } }
    };
    subscriber.on("message", this.onMessage);
  }
  static connect(url: string, options: Redis.RedisOptions = {}) { return new RedisCancelBus(new Redis(url, options), new Redis(url, options), true); }
  async request(sessionId: string) { await this.publisher.publish(`openharness:cancel:${sessionId}`, "1"); }
  onCancel(sessionId: string, listener: () => void) {
    let set = this.listeners.get(sessionId);
    if (!set) { set = new Set(); this.listeners.set(sessionId, set); void this.subscriber.subscribe(`openharness:cancel:${sessionId}`); }
    set.add(listener);
    return () => {
      const current = this.listeners.get(sessionId);
      current?.delete(listener);
      if (current?.size === 0) { this.listeners.delete(sessionId); void this.subscriber.unsubscribe(`openharness:cancel:${sessionId}`); }
    };
  }
  async close() { this.subscriber.off("message", this.onMessage); if (this.ownsClients) await Promise.all([this.publisher.quit(), this.subscriber.quit()]); }
}
