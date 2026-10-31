import type { OpenHarnessEvent } from "@openharness/sdk";
import type { EventEnvelope, InProcessEventBus, StateStore } from "@openharness/core";

export class RunEventEmitter {
  private readonly stateStore: StateStore;
  private readonly eventBus: InProcessEventBus;
  private readonly deltaBuffers = new Map<
    string,
    {
      tenantId: string;
      sessionId: string;
      messageId?: string;
      textDelta: string;
      reasoningDelta: string;
      timer: NodeJS.Timeout;
    }
  >();
  private readonly batchWindowMs: number;

  constructor(opts: {
    stateStore: StateStore;
    eventBus: InProcessEventBus;
    batchWindowMs?: number;
  }) {
    this.stateStore = opts.stateStore;
    this.eventBus = opts.eventBus;
    this.batchWindowMs = opts.batchWindowMs ?? 50;
  }

  /**
   * Emits a durable event with monotonic per-session `seq` and updates `session.lastSeq` (H2).
   */
  async emit(
    tenantId: string,
    sessionId: string,
    event: OpenHarnessEvent
  ): Promise<EventEnvelope> {
    if (event.type !== "part.delta") {
      await this.flushDelta(sessionId);
    }
    const env = await this.stateStore.appendEvent(tenantId, sessionId, event);
    const session = await this.stateStore.getSession(tenantId, sessionId);
    if (session && (session.lastSeq ?? 0) < env.seq) {
      await this.stateStore.saveSession(tenantId, {
        ...session,
        lastSeq: env.seq,
      });
    }
    this.eventBus.publish(env);
    return env;
  }

  /**
   * Batches streaming token deltas in memory and broadcasts them without persisting
   * each token chunk as a separate disk record (H2).
   */
  emitDelta(
    tenantId: string,
    sessionId: string,
    delta: string,
    messageId?: string,
    partType: "text" | "reasoning" = "text"
  ): void {
    if (!delta) return;
    const key = `${sessionId}\u0000${messageId ?? ""}`;
    const existing = this.deltaBuffers.get(key);
    if (existing) {
      if (partType === "reasoning") existing.reasoningDelta += delta;
      else existing.textDelta += delta;
      if (messageId) existing.messageId = messageId;
      return;
    }
    const timer = setTimeout(() => {
      void this.flushDelta(sessionId);
    }, this.batchWindowMs);
    this.deltaBuffers.set(key, {
      tenantId,
      sessionId,
      messageId,
      textDelta: partType === "text" ? delta : "",
      reasoningDelta: partType === "reasoning" ? delta : "",
      timer,
    });
  }

  async flushDelta(sessionId: string): Promise<void> {
    const pending = [...this.deltaBuffers.entries()].filter(
      ([, entry]) => entry.sessionId === sessionId
    );
    for (const [key, entry] of pending) {
      clearTimeout(entry.timer);
      this.deltaBuffers.delete(key);
    }
    for (const [, entry] of pending) {
      const lastSeq = await this.stateStore.getLastSeq(entry.tenantId, entry.sessionId);
      const syntheticEnvelope: EventEnvelope = {
        seq: lastSeq,
        tenantId: entry.tenantId,
        sessionId: entry.sessionId,
        createdAt: Date.now(),
        event: {
          type: "part.delta",
          sessionId: entry.sessionId,
          messageId: entry.messageId,
          delta: entry.textDelta,
          deltas: {
            ...(entry.textDelta ? { text: entry.textDelta } : {}),
            ...(entry.reasoningDelta ? { reasoning: entry.reasoningDelta } : {}),
          },
          seq: lastSeq,
        },
      };
      this.eventBus.publish(syntheticEnvelope);
    }
  }
}
