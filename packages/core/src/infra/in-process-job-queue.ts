import fs from "node:fs";
import path from "node:path";
import type { StepCheckpoint } from "../agent/deps.ts";

export type JobStatus =
  | "queued"
  | "claimed"
  | "waiting"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

export interface JobRecord {
  id: string;
  runId: string;
  sessionId: string;
  tenantId: string;
  prompt: string;
  agent: string;
  model: string;
  mode: "chat" | "task" | "long_task";
  status: JobStatus;
  workerId: string | null;
  fenceToken: number;
  leaseExpiresAt: number | null;
  waitReason?: "permission" | "retry" | "quota" | "paused";
  resumeAt?: number | null;
  checkpoint: StepCheckpoint | null;
  createdAt: number;
  updatedAt: number;
  error?: string;
}

export interface JobQueue {
  enqueue(job: Omit<JobRecord, "status" | "workerId" | "fenceToken" | "leaseExpiresAt" | "checkpoint" | "createdAt" | "updatedAt">): Promise<JobRecord>;
  claim(workerId: string, leaseMs?: number): Promise<JobRecord | null>;
  heartbeat(jobId: string, workerId: string, fenceToken: number, leaseMs?: number): Promise<boolean>;
  saveCheckpoint(jobId: string, workerId: string, fenceToken: number, checkpoint: StepCheckpoint): Promise<boolean>;
  moveToWaiting(jobId: string, workerId: string, fenceToken: number, reason: "permission" | "retry" | "quota" | "paused", resumeAt?: number): Promise<boolean>;
  resumeWaiting(jobId: string): Promise<boolean>;
  complete(jobId: string, workerId: string, fenceToken: number): Promise<boolean>;
  fail(jobId: string, workerId: string, fenceToken: number, error: string): Promise<boolean>;
  cancel(jobId: string): Promise<boolean>;
  reapExpiredLeases(now?: number): Promise<string[]>;
  getJob(jobId: string): Promise<JobRecord | null>;
  getJobByRunId(runId: string): Promise<JobRecord | null>;
  listJobs(filter?: { tenantId?: string; status?: JobStatus }): Promise<JobRecord[]>;
}

export class InProcessJobQueue implements JobQueue {
  private jobs = new Map<string, JobRecord>();
  private lastClaimedTenantIdx = 0;
  private filePath: string | null;

  constructor(opts?: { dataDir?: string; filePath?: string }) {
    if (opts?.filePath) {
      this.filePath = opts.filePath;
    } else if (opts?.dataDir) {
      fs.mkdirSync(opts.dataDir, { recursive: true });
      this.filePath = path.join(opts.dataDir, "jobs.json");
    } else {
      this.filePath = null;
    }
    this.loadFromDisk();
  }

  private loadFromDisk(): void {
    if (!this.filePath || !fs.existsSync(this.filePath)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as JobRecord[];
      if (Array.isArray(raw)) {
        for (const job of raw) {
          this.jobs.set(job.id, job);
        }
      }
    } catch {
      // ignore corrupted file
    }
  }

  private persistToDisk(): void {
    if (!this.filePath) return;
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(Array.from(this.jobs.values()), null, 2), "utf8");
    fs.renameSync(tmp, this.filePath);
  }

  async enqueue(
    input: Omit<
      JobRecord,
      "status" | "workerId" | "fenceToken" | "leaseExpiresAt" | "checkpoint" | "createdAt" | "updatedAt"
    >
  ): Promise<JobRecord> {
    const now = Date.now();
    const record: JobRecord = {
      ...input,
      status: "queued",
      workerId: null,
      fenceToken: 0,
      leaseExpiresAt: null,
      checkpoint: null,
      createdAt: now,
      updatedAt: now,
    };
    this.jobs.set(record.id, record);
    this.persistToDisk();
    return structuredClone(record);
  }

  async claim(workerId: string, leaseMs = 30_000): Promise<JobRecord | null> {
    const now = Date.now();
    // Reap expired leases automatically before claiming
    await this.reapExpiredLeases(now);

    const queued = Array.from(this.jobs.values()).filter((j) => j.status === "queued");
    if (queued.length === 0) return null;

    // Fair per-tenant round-robin interleaving
    const tenants = Array.from(new Set(queued.map((j) => j.tenantId)));
    this.lastClaimedTenantIdx = (this.lastClaimedTenantIdx + 1) % tenants.length;
    const targetTenant = tenants[this.lastClaimedTenantIdx]!;
    const candidate =
      queued.find((j) => j.tenantId === targetTenant) ?? queued[0]!;

    candidate.status = "claimed";
    candidate.workerId = workerId;
    candidate.fenceToken += 1;
    candidate.leaseExpiresAt = now + leaseMs;
    candidate.updatedAt = now;
    this.persistToDisk();
    return structuredClone(candidate);
  }

  async heartbeat(
    jobId: string,
    workerId: string,
    fenceToken: number,
    leaseMs = 30_000
  ): Promise<boolean> {
    const job = this.jobs.get(jobId);
    if (!job || job.status !== "claimed" || job.workerId !== workerId || job.fenceToken !== fenceToken) {
      return false;
    }
    const now = Date.now();
    job.leaseExpiresAt = now + leaseMs;
    job.updatedAt = now;
    this.persistToDisk();
    return true;
  }

  async saveCheckpoint(
    jobId: string,
    workerId: string,
    fenceToken: number,
    checkpoint: StepCheckpoint
  ): Promise<boolean> {
    const job = this.jobs.get(jobId);
    if (!job || job.workerId !== workerId || job.fenceToken !== fenceToken) {
      return false;
    }
    job.checkpoint = structuredClone(checkpoint);
    job.updatedAt = Date.now();
    this.persistToDisk();
    return true;
  }

  async moveToWaiting(
    jobId: string,
    workerId: string,
    fenceToken: number,
    reason: "permission" | "retry" | "quota" | "paused",
    resumeAt?: number
  ): Promise<boolean> {
    const job = this.jobs.get(jobId);
    if (!job || job.workerId !== workerId || job.fenceToken !== fenceToken) {
      return false;
    }
    job.status = reason === "paused" ? "paused" : "waiting";
    job.waitReason = reason;
    job.resumeAt = resumeAt ?? null;
    job.workerId = null;
    job.leaseExpiresAt = null;
    job.updatedAt = Date.now();
    this.persistToDisk();
    return true;
  }

  async resumeWaiting(jobId: string): Promise<boolean> {
    const job = this.jobs.get(jobId);
    if (!job || (job.status !== "waiting" && job.status !== "paused")) {
      return false;
    }
    job.status = "queued";
    job.waitReason = undefined;
    job.resumeAt = null;
    job.updatedAt = Date.now();
    this.persistToDisk();
    return true;
  }

  async complete(jobId: string, workerId: string, fenceToken: number): Promise<boolean> {
    const job = this.jobs.get(jobId);
    if (!job || job.workerId !== workerId || job.fenceToken !== fenceToken) {
      return false;
    }
    job.status = "completed";
    job.workerId = null;
    job.leaseExpiresAt = null;
    job.updatedAt = Date.now();
    this.persistToDisk();
    return true;
  }

  async fail(jobId: string, workerId: string, fenceToken: number, error: string): Promise<boolean> {
    const job = this.jobs.get(jobId);
    if (!job || job.workerId !== workerId || job.fenceToken !== fenceToken) {
      return false;
    }
    job.status = "failed";
    job.error = error;
    job.workerId = null;
    job.leaseExpiresAt = null;
    job.updatedAt = Date.now();
    this.persistToDisk();
    return true;
  }

  async cancel(jobId: string): Promise<boolean> {
    const job = this.jobs.get(jobId);
    if (!job) return false;
    if (job.status === "completed" || job.status === "failed" || job.status === "cancelled") {
      return false;
    }
    job.status = "cancelled";
    job.workerId = null;
    job.leaseExpiresAt = null;
    job.updatedAt = Date.now();
    this.persistToDisk();
    return true;
  }

  async reapExpiredLeases(now = Date.now()): Promise<string[]> {
    const reaped: string[] = [];
    for (const job of this.jobs.values()) {
      if (job.status === "claimed" && job.leaseExpiresAt !== null && job.leaseExpiresAt <= now) {
        job.status = "queued";
        job.workerId = null;
        job.leaseExpiresAt = null;
        job.updatedAt = now;
        reaped.push(job.id);
      } else if (job.status === "waiting" && job.resumeAt && job.resumeAt <= now && job.waitReason !== "permission") {
        job.status = "queued";
        job.waitReason = undefined;
        job.resumeAt = null;
        job.updatedAt = now;
        reaped.push(job.id);
      }
    }
    if (reaped.length > 0) {
      this.persistToDisk();
    }
    return reaped;
  }

  async getJob(jobId: string): Promise<JobRecord | null> {
    const job = this.jobs.get(jobId);
    return job ? structuredClone(job) : null;
  }

  async getJobByRunId(runId: string): Promise<JobRecord | null> {
    for (const job of this.jobs.values()) {
      if (job.runId === runId) return structuredClone(job);
    }
    return null;
  }

  async listJobs(filter?: { tenantId?: string; status?: JobStatus }): Promise<JobRecord[]> {
    return Array.from(this.jobs.values())
      .filter((j) => {
        if (filter?.tenantId && j.tenantId !== filter.tenantId) return false;
        if (filter?.status && j.status !== filter.status) return false;
        return true;
      })
      .map((j) => structuredClone(j));
  }
}
