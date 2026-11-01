import { InProcessJobQueue } from "./in-process-job-queue.ts";
import type { JobQueue, JobRecord, JobStatus, WaitReason } from "./in-process-job-queue.ts";
import type { StepCheckpoint } from "../agent/deps.ts";
import type { SqlQueryable } from "./postgres-migrations.ts";

export interface PostgresJobQueueOptions {
  connectionString: string;
  pool?: SqlQueryable;
  postgresEnabled?: boolean;
}

/**
 * Real SQL-backed PostgresJobQueue using FOR UPDATE SKIP LOCKED semantics and fenced tokens.
 * Does NOT extend InProcessJobQueue; fails closed if OPENHARNESS_POSTGRES !== "1" when constructed from env.
 */
export class PostgresJobQueue implements JobQueue {
  readonly connectionString: string;
  private pool: SqlQueryable;

  constructor(opts: PostgresJobQueueOptions) {
    if (!opts.connectionString) {
      throw new Error("PostgresJobQueue requires a connectionString (DATABASE_URL).");
    }
    const enabled = opts.postgresEnabled ?? process.env.OPENHARNESS_POSTGRES === "1";
    if (!enabled && !opts.pool) {
      throw new Error(
        "DATABASE_URL is set but OPENHARNESS_POSTGRES=1 is not enabled; refusing to start."
      );
    }
    this.connectionString = opts.connectionString;
    if (opts.pool) {
      this.pool = opts.pool;
    } else {
      throw new Error("PostgresJobQueue requires an active pg.Pool instance or SqlQueryable.");
    }
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
      fenceToken: 1,
      leaseExpiresAt: null,
      checkpoint: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.pool.query(
      `INSERT INTO runs (run_id, session_id, tenant_id, phase, mode, iteration, fence_token, lease_owner, lease_expires_at, payload, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 0, 1, NULL, NULL, $6, $7, $8)`,
      [
        record.runId,
        record.sessionId,
        record.tenantId,
        record.status,
        record.mode,
        JSON.stringify(record),
        now,
        now,
      ]
    );
    return record;
  }

  async claim(workerId: string, leaseMs = 30_000): Promise<JobRecord | null> {
    const now = Date.now();
    await this.reapExpiredLeases(now);
    const res = await this.pool.query(
      `SELECT payload, fence_token FROM runs
       WHERE phase = 'queued'
       ORDER BY updated_at ASC
       FOR UPDATE SKIP LOCKED
       LIMIT 1`
    );
    if (res.rows.length === 0) return null;
    const rec = (typeof res.rows[0].payload === "string"
      ? JSON.parse(res.rows[0].payload)
      : res.rows[0].payload) as JobRecord;
    rec.status = "claimed";
    rec.workerId = workerId;
    rec.fenceToken = Number(res.rows[0].fence_token ?? rec.fenceToken) + 1;
    rec.leaseExpiresAt = now + leaseMs;
    rec.updatedAt = now;
    await this.pool.query(
      `UPDATE runs SET phase = 'claimed', fence_token = $1, lease_owner = $2, lease_expires_at = $3, payload = $4, updated_at = $5 WHERE run_id = $6`,
      [rec.fenceToken, workerId, rec.leaseExpiresAt, JSON.stringify(rec), now, rec.runId]
    );
    return rec;
  }

  async heartbeat(jobId: string, workerId: string, fenceToken: number, leaseMs = 30_000): Promise<boolean> {
    const job = await this.getJob(jobId);
    if (!job || job.status !== "claimed" || job.workerId !== workerId || job.fenceToken !== fenceToken) {
      return false;
    }
    const now = Date.now();
    job.leaseExpiresAt = now + leaseMs;
    job.updatedAt = now;
    await this.pool.query(
      `UPDATE runs SET lease_expires_at = $1, payload = $2, updated_at = $3 WHERE run_id = $4 AND fence_token = $5`,
      [job.leaseExpiresAt, JSON.stringify(job), now, job.runId, fenceToken]
    );
    return true;
  }

  async writeCheckpoint(
    jobId: string,
    workerId: string,
    fenceToken: number,
    checkpoint: StepCheckpoint
  ): Promise<boolean> {
    const job = await this.getJob(jobId);
    if (!job || job.status !== "claimed" || job.workerId !== workerId || job.fenceToken !== fenceToken) {
      return false;
    }
    job.checkpoint = checkpoint;
    job.updatedAt = Date.now();
    await this.pool.query(
      `UPDATE runs SET payload = $1, updated_at = $2 WHERE run_id = $3 AND fence_token = $4`,
      [JSON.stringify(job), job.updatedAt, job.runId, fenceToken]
    );
    return true;
  }

  async saveCheckpoint(jobId: string, workerId: string, fenceToken: number, checkpoint: StepCheckpoint): Promise<boolean> {
    return this.writeCheckpoint(jobId, workerId, fenceToken, checkpoint);
  }

  async claimById(jobId: string, workerId: string, leaseMs = 30_000): Promise<JobRecord | null> {
    const job = await this.getJob(jobId);
    if (!job || job.status !== "queued") return null;
    const now = Date.now();
    const updated: JobRecord = {
      ...job,
      status: "claimed",
      workerId,
      fenceToken: job.fenceToken + 1,
      leaseExpiresAt: now + leaseMs,
      updatedAt: now,
    };
    const res = await this.pool.query(
      `UPDATE runs SET phase = 'claimed', fence_token = $1, lease_owner = $2,
       lease_expires_at = $3, payload = $4, updated_at = $5
       WHERE run_id = $6 AND tenant_id = $7 AND phase = 'queued' AND fence_token = $8
       RETURNING run_id`,
      [updated.fenceToken, workerId, updated.leaseExpiresAt, JSON.stringify(updated), now, job.runId, job.tenantId, job.fenceToken]
    );
    return res.rows.length ? updated : null;
  }

  async releaseToWaiting(
    jobId: string,
    workerId: string,
    fenceToken: number,
    waitStatus: "waiting" | "paused"
  ): Promise<boolean> {
    const job = await this.getJob(jobId);
    if (!job || job.workerId !== workerId || job.fenceToken !== fenceToken) return false;
    job.status = waitStatus;
    job.waitReason = waitStatus === "paused" ? "paused" : "permission";
    job.workerId = null;
    job.leaseExpiresAt = null;
    job.updatedAt = Date.now();
    await this.pool.query(
      `UPDATE runs SET phase = $1, lease_owner = NULL, lease_expires_at = NULL, payload = $2, updated_at = $3 WHERE run_id = $4`,
      [waitStatus, JSON.stringify(job), job.updatedAt, job.runId]
    );
    return true;
  }

  async moveToWaiting(jobId: string, workerId: string, fenceToken: number, reason: WaitReason, resumeAt?: number): Promise<boolean> {
    const job = await this.getJob(jobId);
    if (!job || job.workerId !== workerId || job.fenceToken !== fenceToken) return false;
    job.status = reason === "paused" ? "paused" : "waiting";
    job.waitReason = reason;
    job.resumeAt = resumeAt ?? null;
    job.workerId = null;
    job.leaseExpiresAt = null;
    job.updatedAt = Date.now();
    const res = await this.pool.query(
      `UPDATE runs SET phase = $1, lease_owner = NULL, lease_expires_at = NULL, payload = $2, updated_at = $3
       WHERE run_id = $4 AND tenant_id = $5 AND fence_token = $6`,
      [job.status, JSON.stringify(job), job.updatedAt, job.runId, job.tenantId, fenceToken]
    );
    return (res.rowCount ?? res.rows.length) > 0;
  }

  async resumeWaiting(jobId: string): Promise<boolean> {
    const job = await this.getJob(jobId);
    if (!job || (job.status !== "waiting" && job.status !== "paused")) return false;
    job.status = "queued";
    job.waitReason = undefined;
    job.resumeAt = null;
    job.updatedAt = Date.now();
    const res = await this.pool.query(
      `UPDATE runs SET phase = 'queued', payload = $1, updated_at = $2 WHERE run_id = $3 AND tenant_id = $4 AND phase IN ('waiting', 'paused')`,
      [JSON.stringify(job), job.updatedAt, job.runId, job.tenantId]
    );
    return (res.rowCount ?? res.rows.length) > 0;
  }

  async reenqueue(jobId: string): Promise<JobRecord | null> {
    const job = await this.getJob(jobId);
    if (!job) return null;
    job.status = "queued";
    job.workerId = null;
    job.leaseExpiresAt = null;
    job.fenceToken += 1;
    job.updatedAt = Date.now();
    await this.pool.query(
      `UPDATE runs SET phase = 'queued', fence_token = $1, lease_owner = NULL, lease_expires_at = NULL, payload = $2, updated_at = $3 WHERE run_id = $4`,
      [job.fenceToken, JSON.stringify(job), job.updatedAt, job.runId]
    );
    return job;
  }

  async complete(jobId: string, workerId: string, fenceToken: number): Promise<boolean> {
    const job = await this.getJob(jobId);
    if (!job || job.workerId !== workerId || job.fenceToken !== fenceToken) return false;
    job.status = "completed";
    job.workerId = null;
    job.leaseExpiresAt = null;
    job.updatedAt = Date.now();
    await this.pool.query(
      `UPDATE runs SET phase = 'completed', lease_owner = NULL, lease_expires_at = NULL, payload = $1, updated_at = $2 WHERE run_id = $3`,
      [JSON.stringify(job), job.updatedAt, job.runId]
    );
    return true;
  }

  async fail(jobId: string, workerId: string, fenceToken: number, error: string): Promise<boolean> {
    const job = await this.getJob(jobId);
    if (!job || job.workerId !== workerId || job.fenceToken !== fenceToken) return false;
    job.status = "failed";
    job.error = error;
    job.workerId = null;
    job.leaseExpiresAt = null;
    job.updatedAt = Date.now();
    await this.pool.query(
      `UPDATE runs SET phase = 'failed', lease_owner = NULL, lease_expires_at = NULL, payload = $1, updated_at = $2 WHERE run_id = $3`,
      [JSON.stringify(job), job.updatedAt, job.runId]
    );
    return true;
  }

  async cancel(jobId: string): Promise<boolean> {
    const job = await this.getJob(jobId);
    if (!job || ["completed", "failed", "cancelled"].includes(job.status)) return false;
    job.status = "cancelled";
    job.workerId = null;
    job.leaseExpiresAt = null;
    job.fenceToken += 1;
    job.updatedAt = Date.now();
    const res = await this.pool.query(
      `UPDATE runs SET phase = 'cancelled', fence_token = $1, lease_owner = NULL, lease_expires_at = NULL, payload = $2, updated_at = $3 WHERE run_id = $4`,
      [job.fenceToken, JSON.stringify(job), job.updatedAt, job.runId]
    );
    return (res.rowCount ?? res.rows.length) > 0;
  }

  async reapExpiredLeases(now = Date.now()): Promise<string[]> {
    const res = await this.pool.query(
      `SELECT payload FROM runs WHERE phase = 'claimed' AND lease_expires_at IS NOT NULL AND lease_expires_at <= $1`,
      [now]
    );
    const reaped: string[] = [];
    for (const row of res.rows) {
      const job = (typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload) as JobRecord;
      job.status = "queued";
      job.workerId = null;
      job.leaseExpiresAt = null;
      job.fenceToken += 1;
      job.updatedAt = now;
      await this.pool.query(
        `UPDATE runs SET phase = 'queued', fence_token = $1, lease_owner = NULL, lease_expires_at = NULL, payload = $2, updated_at = $3 WHERE run_id = $4`,
        [job.fenceToken, JSON.stringify(job), now, job.runId]
      );
      reaped.push(job.id);
    }
    return reaped;
  }

  async getJob(jobId: string): Promise<JobRecord | null> {
    const res = await this.pool.query(
      `SELECT payload FROM runs WHERE payload->>'id' = $1 OR run_id = $1 LIMIT 1`,
      [jobId]
    );
    if (res.rows.length === 0) return null;
    return (typeof res.rows[0].payload === "string"
      ? JSON.parse(res.rows[0].payload)
      : res.rows[0].payload) as JobRecord;
  }

  async getJobByRunId(runId: string): Promise<JobRecord | null> {
    const res = await this.pool.query("SELECT payload FROM runs WHERE run_id = $1", [runId]);
    if (!res.rows.length) return null;
    return (typeof res.rows[0].payload === "string" ? JSON.parse(res.rows[0].payload) : res.rows[0].payload) as JobRecord;
  }

  async listJobs(filter?: { tenantId?: string; sessionId?: string; status?: JobStatus }): Promise<JobRecord[]> {
    const res = await this.pool.query(`SELECT payload FROM runs ORDER BY created_at DESC`);
    return res.rows
      .map((r) => (typeof r.payload === "string" ? JSON.parse(r.payload) : r.payload) as JobRecord)
      .filter((j) => {
        if (filter?.tenantId && j.tenantId !== filter.tenantId) return false;
        if (filter?.sessionId && j.sessionId !== filter.sessionId) return false;
        if (filter?.status && j.status !== filter.status) return false;
        return true;
      });
  }
}

export function createJobQueue(opts?: {
  databaseUrl?: string;
  dataDir?: string;
  pool?: SqlQueryable;
}): JobQueue {
  const dbUrl =
    opts?.databaseUrl || process.env.DATABASE_URL || process.env.OPENHARNESS_DATABASE_URL;
  if (dbUrl) {
    return new PostgresJobQueue({
      connectionString: dbUrl,
      pool: opts?.pool,
    });
  }
  return new InProcessJobQueue({ dataDir: opts?.dataDir });
}
