import type { CancelBus, JobDocument, JobQueue, JobWaitReason, QuotaService } from "./contracts.ts";

export type WorkerOutcome<Result = unknown> =
  | { status: "succeeded"; result?: Result }
  | { status: "waiting"; reason: JobWaitReason; wakeAt?: number }
  | { status: "cancelled" };

export interface DurableWorkerOptions<Job extends JobDocument> {
  queue: JobQueue<Job>;
  cancelBus?: CancelBus;
  workerId: string;
  kinds: Job["kind"][];
  concurrency?: number;
  leaseMs?: number;
  heartbeatMs?: number;
  pollMs?: number;
  drainMs?: number;
  quota?: { service: QuotaService; limits(job: Job): { tenant?: number; user?: number } };
  handle(job: Job, context: { signal: AbortSignal; checkpoint(value: NonNullable<Job["checkpoint"]>): Promise<void> }): Promise<WorkerOutcome<Job["result"]>>;
  onError?(job: Job, error: unknown): void;
}

type ActiveJob<Job extends JobDocument> = { job: Job; controller: AbortController; done: Promise<void>; stopping: boolean; released?: boolean };

/** Worker process loop shared by distributed workers. Queue writes remain fenced. */
export class DurableWorker<Job extends JobDocument = JobDocument> {
  private readonly active = new Map<string, ActiveJob<Job>>();
  private stopping = false;
  private started?: Promise<void>;
  private wake?: () => void;
  private readonly concurrency: number;
  private readonly heartbeatMs: number;
  private readonly pollMs: number;
  private readonly drainMs: number;
  private readonly leaseMs: number;

  constructor(private readonly options: DurableWorkerOptions<Job>) {
    if (!options.workerId) throw new Error("workerId is required");
    if (!options.kinds.length) throw new Error("at least one job kind is required");
    this.concurrency = positiveInt(options.concurrency ?? 4, "concurrency");
    this.leaseMs = positiveInt(options.leaseMs ?? 60_000, "leaseMs");
    this.heartbeatMs = positiveInt(options.heartbeatMs ?? 15_000, "heartbeatMs");
    this.pollMs = positiveInt(options.pollMs ?? 1_000, "pollMs");
    this.drainMs = positiveInt(options.drainMs ?? 25_000, "drainMs");
    if (this.heartbeatMs >= this.leaseMs) throw new Error("heartbeatMs must be shorter than leaseMs");
  }

  start(): Promise<void> {
    if (this.started) return this.started;
    this.started = this.loop();
    return this.started;
  }

  async stop(drainMs = this.drainMs) {
    this.stopping = true;
    this.wake?.();
    const active = [...this.active.values()];
    if (active.length) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.allSettled(active.map((entry) => entry.done)),
        new Promise<void>((resolve) => { timer = setTimeout(resolve, drainMs); }),
      ]);
      if (timer) clearTimeout(timer);
    }
    for (const entry of this.active.values()) {
      entry.stopping = true;
      entry.controller.abort(new Error("worker is shutting down"));
    }
    await Promise.allSettled([...this.active.values()].map((entry) => this.release(entry)));
    await Promise.race([Promise.allSettled([...this.active.values()].map((entry) => entry.done)), delay(1_000)]);
    await this.started;
  }

  private async loop() {
    let lastHeartbeat = 0;
    while (!this.stopping) {
      const now = Date.now();
      if (now - lastHeartbeat >= this.heartbeatMs) {
        await this.heartbeat();
        lastHeartbeat = now;
      }
      const slots = this.concurrency - this.active.size;
      if (slots > 0) {
        const claimed = await this.options.queue.claim(this.options.workerId, this.options.kinds, slots);
        if (this.stopping) {
          await Promise.allSettled(claimed.map((job) => this.options.queue.requeue(job.id, this.options.workerId, job.fence)));
        } else for (const job of claimed) this.launch(job);
      }
      if (this.stopping) break;
      await new Promise<void>((resolve) => {
        let timer: ReturnType<typeof setTimeout>;
        const done = () => { clearTimeout(timer); this.wake = undefined; resolve(); };
        timer = setTimeout(done, this.pollMs);
        this.wake = done;
      });
    }
  }

  private launch(job: Job) {
    const entry: ActiveJob<Job> = { job, controller: new AbortController(), done: Promise.resolve(), stopping: false };
    entry.done = this.execute(entry).finally(() => {
      this.active.delete(job.id);
      this.wake?.();
    });
    this.active.set(job.id, entry);
  }

  private async execute(entry: ActiveJob<Job>) {
    const { job, controller } = entry;
    const unsubscribe = this.options.cancelBus?.onCancel(job.sessionId, () => {
      void this.options.queue.requestCancel(job.id).finally(() => controller.abort(new Error("job cancelled")));
    });
    let quotaAcquired = false;
    try {
      if (this.options.quota) {
        const limits = this.options.quota.limits(job);
        quotaAcquired = await this.options.quota.service.acquireRunSlot(job.tenantId, String((job.input as any)?.userId ?? "unknown"), { ...limits, leaseId: job.id, leaseMs: this.leaseMs });
        if (!quotaAcquired) {
          await this.options.queue.wait(job.id, this.options.workerId, job.fence, "quota", Date.now() + this.pollMs);
          return;
        }
      }
      const outcome = await this.options.handle(job, {
        signal: controller.signal,
        checkpoint: (value) => this.options.queue.checkpoint(job.id, this.options.workerId, job.fence, value),
      });
      if (outcome.status === "waiting") await this.options.queue.wait(job.id, this.options.workerId, job.fence, outcome.reason, outcome.wakeAt);
      else {
        if (outcome.status === "cancelled") await this.options.queue.requestCancel(job.id);
        await this.options.queue.complete(job.id, this.options.workerId, job.fence, outcome.status === "succeeded" ? outcome.result : undefined);
      }
    } catch (error) {
      if (entry.stopping) {
        await this.release(entry);
      } else if (controller.signal.aborted) {
        try { await this.options.queue.complete(job.id, this.options.workerId, job.fence); }
        catch (completeError) { this.options.onError?.(job, completeError); }
      } else {
        try { await this.options.queue.fail(job.id, this.options.workerId, job.fence, error instanceof Error ? error.message : String(error)); }
        catch (failError) { this.options.onError?.(job, failError); }
        this.options.onError?.(job, error);
      }
    } finally {
      unsubscribe?.();
      if (quotaAcquired && this.options.quota) {
        const userId = String((job.input as any)?.userId ?? "unknown");
        await this.options.quota.service.releaseRunSlot(job.tenantId, userId, job.id).catch((error) => this.options.onError?.(job, error));
      }
    }
  }

  private async heartbeat() {
    const ids = [...this.active.keys()];
    if (!ids.length) return;
    try {
      const { lost } = await this.options.queue.heartbeat(ids, this.options.workerId);
      for (const id of lost) this.active.get(id)?.controller.abort(new Error("job lease lost"));
      if (this.options.quota) {
        await Promise.all([...this.active.values()].map(async (entry) => {
          const userId = String((entry.job.input as any)?.userId ?? "unknown");
          const held = await this.options.quota!.service.acquireRunSlot(entry.job.tenantId, userId, {
            ...this.options.quota!.limits(entry.job), leaseId: entry.job.id, leaseMs: this.leaseMs,
          });
          if (!held) entry.controller.abort(new Error("run quota lease lost"));
        }));
      }
    } catch (error) {
      // A transient heartbeat failure is bounded by the lease; retry on next loop.
      for (const entry of this.active.values()) this.options.onError?.(entry.job, error);
    }
  }

  private async release(entry: ActiveJob<Job>) {
    if (entry.released) return;
    entry.released = true;
    try { await this.options.queue.requeue(entry.job.id, this.options.workerId, entry.job.fence); }
    catch (error) { this.options.onError?.(entry.job, error); }
  }
}

function positiveInt(value: number, name: string) {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

function delay(ms: number) { return new Promise<void>((resolve) => setTimeout(resolve, ms)); }
