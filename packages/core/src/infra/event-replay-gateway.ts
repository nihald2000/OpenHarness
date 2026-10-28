import type { EventBus, EventEnvelope, StateStore } from "./contracts.ts";

export interface SessionReplayOptions<Event> {
  tenantId: string;
  sessionId: string;
  afterSeq: number;
  pollMs?: number;
  pageSize?: number;
  onGap?: (gap: { expected: number; received: number }) => void;
  listener(envelope: EventEnvelope<Event>): void;
}

/**
 * Subscribe first, then replay and periodically compare the durable sequence.
 * This closes the reconnect race and recovers events lost by Redis pub/sub.
 * The caller supplies one session filter because protocol event sequences are
 * allocated independently per session.
 */
export function subscribeSessionWithReplay<Session, Message, Part, Event, Rule>(
  state: Pick<StateStore<Session, Message, Part, Event, Rule>, "listEvents" | "lastSeq">,
  bus: EventBus<Event>,
  options: SessionReplayOptions<Event>,
) {
  const pageSize = options.pageSize ?? 500;
  const pollMs = options.pollMs ?? 1_000;
  if (!Number.isInteger(options.afterSeq) || options.afterSeq < 0) throw new Error("afterSeq must be a non-negative integer");
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 10_000) throw new Error("pageSize must be from 1 to 10000");
  if (!Number.isInteger(pollMs) || pollMs < 50) throw new Error("pollMs must be at least 50ms");

  let cursor = options.afterSeq;
  let closed = false;
  let pumping: Promise<void> | undefined;
  const pending = new Map<number, EventEnvelope<Event>>();
  const deliver = (envelope: EventEnvelope<Event>) => {
    if (closed || envelope.seq <= cursor) return;
    pending.set(envelope.seq, envelope);
    void pump().catch(() => undefined);
  };
  const unsubscribe = bus.subscribe({ tenantId: options.tenantId, sessionId: options.sessionId }, deliver);

  const pump = async () => {
    if (pumping || closed) return pumping;
    pumping = (async () => {
      const latest = await state.lastSeq(options.tenantId, options.sessionId);
      while (!closed && cursor < latest) {
        const rows = await state.listEvents(options.tenantId, options.sessionId, cursor, pageSize);
        if (!rows.length) break;
        for (const row of rows) {
          if (row.seq <= cursor) continue;
          pending.set(row.seq, {
            tenantId: options.tenantId,
            sessionId: options.sessionId,
            seq: row.seq,
            at: Date.now(),
            data: row.event,
          });
        }
        const last = rows.at(-1)!.seq;
        if (last <= cursor) break;
        // Continue paging until the durable head is covered.
        if (rows.length < pageSize && last >= latest) break;
      }

      while (!closed && pending.size) {
        const next = cursor + 1;
        const exact = pending.get(next);
        if (exact) {
          pending.delete(next);
          cursor = next;
          options.listener(exact);
          continue;
        }
        const received = Math.min(...pending.keys());
        if (received > next) {
          options.onGap?.({ expected: next, received });
          cursor = received - 1;
          continue;
        }
        break;
      }
    })().finally(() => { pumping = undefined; });
    return pumping;
  };

  // Register the bus listener before the initial replay to avoid losing an
  // event committed between the replay query and subscription setup.
  void pump().catch(() => undefined);
  const timer = setInterval(() => { void pump().catch(() => undefined); }, pollMs);
  return {
    get lastSeq() { return cursor; },
    close() { if (closed) return; closed = true; clearInterval(timer); unsubscribe(); pending.clear(); },
  };
}
