import type { JobDocument, JobQueue, JobWaitReason } from "./contracts.ts";

/**
 * In-memory queue for local mode. It mirrors the distributed queue transitions
 * but intentionally does not survive process restarts or coordinate processes.
 */
export class InProcessJobQueue<Job extends JobDocument = JobDocument> implements JobQueue<Job> {
  private readonly jobs = new Map<string, Job>();

  constructor(
    private readonly leaseMs = 60_000,
    private readonly clock: () => number = Date.now,
  ) {
    if (!Number.isInteger(leaseMs) || leaseMs < 1) throw new Error("leaseMs must be a positive integer");
  }

  async enqueue(input: Omit<Job, "status" | "attempt" | "fence">): Promise<Job> {
    if (this.jobs.has(input.id)) throw new Error(`job ${input.id} already exists`);
    if (input.idempotencyKey) {
      const prior = [...this.jobs.values()].find((job) => job.tenantId === input.tenantId && job.idempotencyKey === input.idempotencyKey);
      if (prior) return structuredClone(prior);
    }
    if (input.kind !== "subagent") {
      const active = [...this.jobs.values()].find((job) => job.tenantId === input.tenantId && job.sessionId === input.sessionId && job.kind !== "subagent" && this.active(job));
      if (active) throw new Error(`session ${input.sessionId} already has an active job`);
    }
    const job = { ...structuredClone(input), status: "queued", attempt: 0, fence: 0 } as Job;
    this.jobs.set(job.id, job);
    return structuredClone(job);
  }

  async claim(workerId: string, kinds: Job["kind"][], limit: number): Promise<Job[]> {
    if (!workerId) throw new Error("workerId is required");
    if (!Number.isInteger(limit) || limit < 0) throw new Error("claim limit must be a non-negative integer");
    if (!limit || !kinds.length) return [];
    const now = this.clock();
    for (const job of this.jobs.values()) {
      if ((job.status === "leased" || job.status === "running") && (job.leaseUntil ?? 0) <= now) {
        if (job.attempt >= job.maxAttempts) {
          job.status = "failed";
          job.error = "Job lease expired after the maximum number of attempts.";
          job.updatedAt = now;
        } else {
          job.status = "queued";
          job.leaseOwner = undefined;
          job.leaseUntil = undefined;
          job.updatedAt = now;
        }
      }
    }
    const available = [...this.jobs.values()]
      .filter((job) => job.status === "queued" && job.notBefore <= now && kinds.includes(job.kind))
      .sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt || a.id.localeCompare(b.id))
      .slice(0, limit);
    for (const job of available) {
      job.status = "leased";
      job.attempt++;
      job.fence++;
      job.leaseOwner = workerId;
      job.leaseUntil = now + this.leaseMs;
      job.updatedAt = now;
    }
    return available.map((job) => structuredClone(job));
  }

  async heartbeat(jobIds: string[], workerId: string): Promise<{ lost: string[] }> {
    const now = this.clock();
    const lost: string[] = [];
    for (const jobId of jobIds) {
      const job = this.jobs.get(jobId);
      if (!job || (job.status !== "leased" && job.status !== "running") || job.leaseOwner !== workerId || (job.leaseUntil ?? 0) <= now) {
        lost.push(jobId);
        continue;
      }
      job.leaseUntil = now + this.leaseMs;
      job.updatedAt = now;
    }
    return { lost };
  }

  async checkpoint(jobId: string, workerId: string, fence: number, value: NonNullable<Job["checkpoint"]>): Promise<void> {
    const job = this.requireLease(jobId, workerId, fence);
    job.checkpoint = structuredClone(value) as Job["checkpoint"];
    job.status = "running";
    job.updatedAt = this.clock();
  }

  async complete(jobId: string, workerId: string, fence: number, result?: Job["result"]): Promise<void> {
    const job = this.requireLease(jobId, workerId, fence);
    job.status = job.cancelRequestedAt === undefined ? "succeeded" : "cancelled";
    job.result = structuredClone(result) as Job["result"];
    this.releaseLease(job);
  }

  async fail(jobId: string, workerId: string, fence: number, error: string): Promise<void> {
    const job = this.requireLease(jobId, workerId, fence);
    job.status = "failed";
    job.error = error.slice(0, 4_000);
    this.releaseLease(job);
  }

  async wait(jobId: string, workerId: string, fence: number, reason: JobWaitReason, wakeAt?: number): Promise<void> {
    const job = this.requireLease(jobId, workerId, fence);
    job.status = "waiting";
    job.waitReason = reason;
    job.notBefore = wakeAt ?? Number.MAX_SAFE_INTEGER;
    this.releaseLease(job);
  }

  async requestCancel(jobId: string): Promise<boolean> {
    const job = this.jobs.get(jobId);
    if (!job || !this.active(job)) return false;
    const now = this.clock();
    job.cancelRequestedAt = now;
    if (job.status === "queued" || job.status === "waiting") {
      job.status = "cancelled";
      job.waitReason = undefined;
      this.releaseLease(job);
    } else {
      job.updatedAt = now;
    }
    return true;
  }

  async resume(jobId: string, input?: Partial<Job["input"]>): Promise<boolean> {
    const job = this.jobs.get(jobId);
    if (!job || job.status !== "waiting") return false;
    if (input && typeof input === "object" && !Array.isArray(input) && job.input && typeof job.input === "object" && !Array.isArray(job.input)) {
      job.input = { ...(job.input as object), ...(input as object) } as Job["input"];
    }
    job.status = "queued";
    job.waitReason = undefined;
    job.notBefore = this.clock();
    job.cancelRequestedAt = undefined;
    job.updatedAt = this.clock();
    return true;
  }

  get(jobId: string): Job | undefined {
    const job = this.jobs.get(jobId);
    return job ? structuredClone(job) : undefined;
  }

  private requireLease(jobId: string, workerId: string, fence: number): Job {
    const job = this.jobs.get(jobId);
    if (!job || (job.status !== "leased" && job.status !== "running") || job.leaseOwner !== workerId || job.fence !== fence || (job.leaseUntil ?? 0) <= this.clock()) {
      throw new Error("job lease lost or fencing token is stale");
    }
    return job;
  }

  private releaseLease(job: Job) {
    job.leaseOwner = undefined;
    job.leaseUntil = undefined;
    job.updatedAt = this.clock();
  }

  private active(job: Job) {
    return job.status === "queued" || job.status === "leased" || job.status === "running" || job.status === "waiting";
  }
}
