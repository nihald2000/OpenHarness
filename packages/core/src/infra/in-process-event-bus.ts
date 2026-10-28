import type { EventBus, EventEnvelope } from "./contracts.ts";

/** Single-process fan-out adapter used by the default local deployment. */
export class InProcessEventBus<Event = unknown> implements EventBus<Event> {
  private readonly listeners = new Set<{
    filter: { sessionId?: string; tenantId: string; userId?: string };
    listener: (envelope: EventEnvelope<Event>) => void;
  }>();

  async publish(envelope: EventEnvelope<Event>) {
    for (const entry of this.listeners) {
      if (entry.filter.tenantId !== envelope.tenantId) continue;
      if (entry.filter.sessionId && entry.filter.sessionId !== envelope.sessionId) continue;
      entry.listener(envelope);
    }
  }

  publishDelta(envelope: EventEnvelope<Event>) {
    // Local mode has no separate token-delta stream yet; retain best-effort semantics.
    void this.publish(envelope);
  }

  subscribe(
    filter: { sessionId?: string; tenantId: string; userId?: string },
    listener: (envelope: EventEnvelope<Event>) => void,
  ) {
    const entry = { filter, listener };
    this.listeners.add(entry);
    return () => this.listeners.delete(entry);
  }
}
