import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { InProcessCancelBus, InProcessEventBus, InProcessJobQueue, InProcessLockService, JsonDocumentStore, type EventEnvelope, type JobDocument } from "../../core/src/infra/index.ts";

type TestEvent = { type: string; value?: string };
type TestJob = JobDocument<{ text: string }, { step: number }, { ok: boolean }>;

function job(id: string, now: number, overrides: Partial<TestJob> = {}): Omit<TestJob, "status" | "attempt" | "fence"> {
  return {
    id, tenantId: "tenant-a", sessionId: `session-${id}`, rootSessionId: `session-${id}`,
    kind: "run", priority: 100, maxAttempts: 3, input: { text: "work" }, notBefore: now,
    createdAt: now, updatedAt: now, ...overrides,
  };
}

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

describe("local job queue adapter", () => {
  test("concurrent claimers receive each eligible job at most once", async () => {
    const queue = new InProcessJobQueue<TestJob>(10_000, () => 1_000);
    await Promise.all(Array.from({ length: 100 }, (_, index) => queue.enqueue(job(`j${index}`, 1_000))));
    const batches = await Promise.all(Array.from({ length: 20 }, (_, index) => queue.claim(`worker-${index}`, ["run"], 5)));
    const ids = batches.flat().map((item) => item.id);
    expect(ids).toHaveLength(100);
    expect(new Set(ids).size).toBe(100);
  });

  test("lease expiry reclaims work and rejects stale fenced writes", async () => {
    let now = 1_000;
    const queue = new InProcessJobQueue<TestJob>(100, () => now);
    await queue.enqueue(job("lease", now));
    const [first] = await queue.claim("worker-a", ["run"], 1);
    expect(first).toMatchObject({ status: "leased", attempt: 1, fence: 1, leaseOwner: "worker-a" });
    now += 101;
    const [second] = await queue.claim("worker-b", ["run"], 1);
    expect(second).toMatchObject({ status: "leased", attempt: 2, fence: 2, leaseOwner: "worker-b" });
    await expect(queue.checkpoint("lease", "worker-a", first!.fence, { step: 1 })).rejects.toThrow("lease lost");
    await queue.checkpoint("lease", "worker-b", second!.fence, { step: 2 });
    expect(queue.get("lease")).toMatchObject({ status: "running", checkpoint: { step: 2 } });
    await queue.complete("lease", "worker-b", second!.fence, { ok: true });
    expect(queue.get("lease")).toMatchObject({ status: "succeeded", result: { ok: true } });
  });

  test("waiting releases the lease, resume requeues, and idempotency is tenant-scoped", async () => {
    const queue = new InProcessJobQueue<TestJob>(1_000, () => 1_000);
    const queued = await queue.enqueue(job("wait", 1_000, { idempotencyKey: "request-1" }));
    expect(await queue.enqueue(job("ignored", 1_000, { idempotencyKey: "request-1" }))).toMatchObject({ id: queued.id });
    expect(await queue.enqueue(job("tenant-b", 1_000, { tenantId: "tenant-b", idempotencyKey: "request-1" }))).toMatchObject({ id: "tenant-b", tenantId: "tenant-b" });
    const [claimed] = await queue.claim("worker", ["run"], 1);
    await queue.wait(claimed!.id, "worker", claimed!.fence, "approval");
    expect(queue.get(claimed!.id)).toMatchObject({ status: "waiting", waitReason: "approval", leaseOwner: undefined });
    await expect(queue.enqueue(job("same-session", 1_000, { sessionId: queued.sessionId }))).rejects.toThrow("already has an active job");
    expect(await queue.resume(claimed!.id, { text: "approved input" })).toBe(true);
    expect(await queue.claim("next-worker", ["run"], 1)).toMatchObject([{ id: claimed!.id, status: "leased", input: { text: "approved input" } }]);
  });

  test("cancels queued jobs immediately and marks running jobs for cancellation", async () => {
    let now = 1_000;
    const queue = new InProcessJobQueue<TestJob>(1_000, () => now);
    await queue.enqueue(job("queued", now));
    expect(await queue.requestCancel("queued")).toBe(true);
    expect(queue.get("queued")?.status).toBe("cancelled");
    await queue.enqueue(job("running", now));
    const [running] = await queue.claim("worker", ["run"], 1);
    now++;
    expect(await queue.requestCancel(running!.id)).toBe(true);
    expect(queue.get(running!.id)).toMatchObject({ status: "leased", cancelRequestedAt: now });
  });
});
