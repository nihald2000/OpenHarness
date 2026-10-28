import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { InProcessCancelBus, InProcessEventBus, InProcessLockService, JsonDocumentStore, type EventEnvelope } from "../../core/src/infra/index.ts";

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

describe("local JSON document store adapter", () => {
  test("loads a cloned fallback and atomically round-trips documents", async () => {
    const directory = await mkdtemp(join(process.cwd(), ".infrastructure-test-"));
    try {
      const file = join(directory, "state", "store.json");
      const store = new JsonDocumentStore(file, { sessions: [] as string[] });
      const fallback = await store.load();
      fallback.sessions.push("mutated-copy");
      expect(await store.load()).toEqual({ sessions: [] });

      await store.save({ sessions: ["s1"] });
      expect(await store.load()).toEqual({ sessions: ["s1"] });
      await store.save({ sessions: ["s1", "s2"] });
      expect(await store.load()).toEqual({ sessions: ["s1", "s2"] });
      expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ sessions: ["s1", "s2"] });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("local cancellation bus adapter", () => {
  test("routes cancellation by session and removes listeners", async () => {
    const bus = new InProcessCancelBus();
    const received: string[] = [];
    const unsubscribe = bus.onCancel("s1", () => received.push("s1"));
    bus.onCancel("s2", () => received.push("s2"));
    await bus.request("s1");
    unsubscribe();
    await bus.request("s1");
    await bus.request("s2");
    expect(received).toEqual(["s1", "s2"]);
  });
});

describe("local lock service adapter", () => {
  test("serializes work for one key while allowing independent keys", async () => {
    const locks = new InProcessLockService();
    const order: string[] = [];
    let begin!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { begin = resolve; });
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const first = locks.withLock("same-file", 1_000, async () => {
      order.push("first-start");
      begin();
      await hold;
      order.push("first-end");
    });
    await started;
    const second = locks.withLock("same-file", 1_000, async () => { order.push("second"); });
    await locks.withLock("other-file", 1_000, async () => { order.push("independent"); });
    expect(order).toEqual(["first-start", "independent"]);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["first-start", "independent", "first-end", "second"]);
  });

  test("runs only one local leader callback for a name at a time", async () => {
    const locks = new InProcessLockService();
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const leader = locks.tryLeader("reaper", async () => { await hold; });
    await Promise.resolve();
    expect(await locks.tryLeader("reaper", async () => {})).toBe(false);
    release();
    expect(await leader).toBe(true);
    expect(await locks.tryLeader("reaper", async () => {})).toBe(true);
  });
});
