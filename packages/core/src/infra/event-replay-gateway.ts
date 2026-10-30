import type { EventBus, EventEnvelope, StateStore } from "../agent/deps.ts";

export class EventReplayGateway {
  constructor(
    private readonly stateStore: StateStore,
    private readonly eventBus: EventBus
  ) {}

  async subscribeWithReplay(
    filter: { tenantId: string; sessionId?: string; afterSeq?: number },
    onEvent: (envelope: EventEnvelope) => void
  ): Promise<() => void> {
    let lastSeq = filter.afterSeq ?? 0;
    let replaying = true;
    const buffered: EventEnvelope[] = [];

    const deliver = (env: EventEnvelope) => {
      if (env.seq <= lastSeq) return;
      lastSeq = env.seq;
      onEvent(env);
    };

    const unsub = this.eventBus.subscribe(
      { tenantId: filter.tenantId, sessionId: filter.sessionId },
      (env) => {
        if (replaying) buffered.push(env);
        else deliver(env);
      }
    );

    const history = await this.stateStore.listEventsAfter(
      filter.tenantId,
      lastSeq,
      filter.sessionId
    );
    for (const env of history) deliver(env);
    replaying = false;
    for (const env of buffered) deliver(env);

    return unsub;
  }
}
