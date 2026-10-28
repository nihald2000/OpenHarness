import { describe, expect, test } from "bun:test";
import { InProcessEventBus, type EventEnvelope } from "../../core/src/infra/index.ts";

type TestEvent = { type: string; value?: string };

function envelope(tenantId: string, sessionId: string, seq: number): EventEnvelope<TestEvent> {
  return { tenantId, sessionId, seq, at: seq, data: { type: "test", value: String(seq) } };
}

describe("local event bus adapter", () => {
  test("publishes in order and scopes subscribers by tenant and session", async () => {
    const bus = new InProcessEventBus<TestEvent>();
    const first: number[] = [];
    const otherTenant: number[] = [];
    bus.subscribe({ tenantId: "tenant-a", sessionId: "s1" }, (event) => first.push(event.seq));
    bus.subscribe({ tenantId: "tenant-b", sessionId: "s1" }, (event) => otherTenant.push(event.seq));

    await bus.publish(envelope("tenant-a", "s1", 1));
    await bus.publish(envelope("tenant-a", "s2", 2));
    await bus.publish(envelope("tenant-a", "s1", 3));
    await bus.publish(envelope("tenant-b", "s1", 4));

    expect(first).toEqual([1, 3]);
    expect(otherTenant).toEqual([4]);
  });

  test("unsubscribe stops future delivery", async () => {
    const bus = new InProcessEventBus<TestEvent>();
    const received: number[] = [];
    const unsubscribe = bus.subscribe({ tenantId: "tenant-a" }, (event) => received.push(event.seq));
    await bus.publish(envelope("tenant-a", "s1", 1));
    unsubscribe();
    await bus.publish(envelope("tenant-a", "s1", 2));
    expect(received).toEqual([1]);
  });
});
