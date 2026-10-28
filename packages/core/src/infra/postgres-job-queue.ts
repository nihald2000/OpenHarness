import postgres from "postgres";
import type { Sql } from "postgres";
import type { JobDocument, JobQueue, JobWaitReason } from "./contracts.ts";

/** Durable, lease-based Postgres queue. Fence values are checked on every worker write. */
export class PostgresJobQueue<Job extends JobDocument = JobDocument> implements JobQueue<Job> {
  private constructor(private readonly sql: Sql, private readonly owned: boolean, private readonly leaseMs: number) {}
  static connect<Job extends JobDocument = JobDocument>(url: string, options: postgres.Options<{}> & { leaseMs?: number } = {}) {
    const { leaseMs = 60_000, ...sqlOptions } = options;
    return new PostgresJobQueue<Job>(postgres(url, { max: 10, ...sqlOptions }), true, leaseMs);
  }
  async close() { if (this.owned) await this.sql.end({ timeout: 5 }); }

  async enqueue(input: Omit<Job, "status" | "attempt" | "fence">, options?: { tx?: unknown }): Promise<Job> {
    const db = isSql(options?.tx) ? options!.tx as Sql : this.sql;
    const now = Date.now();
    const rows = await db<Job[]>`INSERT INTO jobs (id,tenant_id,session_id,root_session_id,parent_job_id,kind,status,priority,attempt,max_attempts,not_before,fence,input,checkpoint,result,error,cancel_requested_at,idempotency_key,created_at,updated_at)
      VALUES (${input.id},${input.tenantId}::uuid,${input.sessionId},${input.rootSessionId},${input.parentJobId ?? null},${input.kind},'queued',${input.priority},0,${input.maxAttempts},${input.notBefore},0,${db.json(input.input)},${input.checkpoint === undefined ? null : db.json(input.checkpoint)},${input.result === undefined ? null : db.json(input.result)},${input.error ?? null},${input.cancelRequestedAt ?? null},${input.idempotencyKey ?? null},${input.createdAt ?? now},${input.updatedAt ?? now})
      ON CONFLICT (tenant_id,idempotency_key) DO UPDATE SET id=jobs.id RETURNING *`;
    await db`SELECT pg_notify('jobs_queued', ${input.tenantId})`;
    return decode(rows[0]!);
  }

  async claim(workerId: string, kinds: Job["kind"][], limit: number): Promise<Job[]> {
    if (!workerId) throw new Error("workerId is required");
    if (!Number.isInteger(limit) || limit < 0) throw new Error("claim limit must be a non-negative integer");
    if (!limit || !kinds.length) return [];
    const now = Date.now();
    const rows = await this.sql<Job[]>`WITH ranked AS (
      SELECT j.id,j.tenant_id,j.priority,j.created_at,
        row_number() OVER (PARTITION BY j.tenant_id ORDER BY j.created_at,j.priority,j.id) AS tenant_rank
      FROM jobs j
      WHERE j.status='queued' AND j.not_before <= ${now} AND j.kind=ANY(${kinds})
        AND NOT EXISTS (SELECT 1 FROM tenant_paused tp WHERE tp.tenant_id=j.tenant_id)
    ), candidates AS (
      SELECT id,tenant_rank,priority,created_at FROM ranked ORDER BY tenant_rank,priority,created_at,id LIMIT ${limit * 8}
    ), locked AS (
      SELECT j.id,c.tenant_rank,c.priority,c.created_at FROM jobs j JOIN candidates c ON c.id=j.id
      WHERE j.status='queued' ORDER BY c.tenant_rank,c.priority,c.created_at,j.id FOR UPDATE OF j SKIP LOCKED LIMIT ${limit}
    ) UPDATE jobs j SET status='leased',lease_owner=${workerId},lease_until=${now + this.leaseMs},heartbeat_at=${now},attempt=j.attempt+1,fence=j.fence+1,updated_at=${now}
      FROM locked c WHERE j.id=c.id RETURNING j.*`;
    return rows.map(decode<Job>);
  }

  async heartbeat(jobIds: string[], workerId: string) {
    if (!jobIds.length) return { lost: [] as string[] };
    const now = Date.now();
    const rows = await this.sql<{ id: string }[]>`UPDATE jobs SET lease_until=${now + this.leaseMs},heartbeat_at=${now},updated_at=${now}
      WHERE id=ANY(${jobIds}) AND lease_owner=${workerId} AND status IN ('leased','running') AND lease_until>${now} RETURNING id`;
    const held = new Set(rows.map((row) => row.id));
    return { lost: jobIds.filter((id) => !held.has(id)) };
  }

  async checkpoint(jobId: string, workerId: string, fence: number, value: NonNullable<Job["checkpoint"]>) {
    await this.fenced(jobId, workerId, fence, { checkpoint: this.sql.json(value), status: "running" });
  }
  async complete(jobId: string, workerId: string, fence: number, result?: Job["result"]) {
    const now = Date.now();
    const rows = await this.sql`UPDATE jobs SET status=CASE WHEN cancel_requested_at IS NULL THEN 'succeeded' ELSE 'cancelled' END,result=${result === undefined ? null : this.sql.json(result)},lease_owner=NULL,lease_until=NULL,updated_at=${now}
      WHERE id=${jobId} AND lease_owner=${workerId} AND fence=${fence} AND status IN ('leased','running') AND lease_until>${now} RETURNING id`;
    if (!rows.length) throw lostLease();
  }
  async fail(jobId: string, workerId: string, fence: number, error: string) {
    const now = Date.now();
    const rows = await this.sql`UPDATE jobs SET status='failed',error=${error.slice(0, 4000)},lease_owner=NULL,lease_until=NULL,updated_at=${now}
      WHERE id=${jobId} AND lease_owner=${workerId} AND fence=${fence} AND status IN ('leased','running') AND lease_until>${now} RETURNING id`;
    if (!rows.length) throw lostLease();
  }
  async wait(jobId: string, workerId: string, fence: number, reason: JobWaitReason, wakeAt?: number) {
    const now = Date.now();
    const rows = await this.sql`UPDATE jobs SET status='waiting',wait_reason=${reason},not_before=${wakeAt ?? Number.MAX_SAFE_INTEGER},lease_owner=NULL,lease_until=NULL,updated_at=${now}
      WHERE id=${jobId} AND lease_owner=${workerId} AND fence=${fence} AND status IN ('leased','running') AND lease_until>${now} RETURNING id`;
    if (!rows.length) throw lostLease();
  }
  async requeue(jobId: string, workerId: string, fence: number, notBefore = Date.now()) {
    const now = Date.now();
    const rows = await this.sql`UPDATE jobs SET status='queued',wait_reason=NULL,not_before=${notBefore},lease_owner=NULL,lease_until=NULL,updated_at=${now}
      WHERE id=${jobId} AND lease_owner=${workerId} AND fence=${fence} AND status IN ('leased','running') AND lease_until>${now} RETURNING id`;
    if (!rows.length) throw lostLease();
    await this.sql`SELECT pg_notify('jobs_queued', ${jobId})`;
  }
  async requestCancel(jobId: string) {
    const now = Date.now();
    const rows = await this.sql`UPDATE jobs SET cancel_requested_at=${now},status=CASE WHEN status IN ('queued','waiting') THEN 'cancelled' ELSE status END,wait_reason=CASE WHEN status IN ('queued','waiting') THEN NULL ELSE wait_reason END,lease_owner=CASE WHEN status IN ('queued','waiting') THEN NULL ELSE lease_owner END,lease_until=CASE WHEN status IN ('queued','waiting') THEN NULL ELSE lease_until END,updated_at=${now}
      WHERE id=${jobId} AND status IN ('queued','leased','running','waiting') RETURNING tenant_id`;
    return rows.length > 0;
  }
  async resume(jobId: string, input?: Partial<Job["input"]>) {
    const now = Date.now();
    const rows = await this.sql`UPDATE jobs SET status='queued',wait_reason=NULL,not_before=${now},cancel_requested_at=NULL,input=CASE WHEN ${input === undefined} THEN input ELSE input || ${this.sql.json(input ?? {})} END,updated_at=${now}
      WHERE id=${jobId} AND status='waiting' RETURNING tenant_id`;
    if (rows.length) await this.sql`SELECT pg_notify('jobs_queued', ${String(rows[0]!.tenant_id)})`;
    return rows.length > 0;
  }

  /** Leader/reaper hook: expired workers are safely made claimable again. */
  async requeueExpired(now = Date.now()) {
    const rows = await this.sql`UPDATE jobs SET status=CASE WHEN attempt>=max_attempts THEN 'failed' ELSE 'queued' END,error=CASE WHEN attempt>=max_attempts THEN 'Run failed after ' || attempt || ' worker restarts' ELSE error END,not_before=${now + 1_000},lease_owner=NULL,lease_until=NULL,updated_at=${now}
      WHERE status IN ('leased','running') AND lease_until<${now} RETURNING id,status`;
    return rows.map((row) => ({ id: String(row.id), status: String(row.status) }));
  }

  async wakeDue(now = Date.now()) {
    const rows = await this.sql<{ id: string; tenant_id: string }[]>`UPDATE jobs SET status='queued',wait_reason=NULL,updated_at=${now}
      WHERE status='waiting' AND wait_reason IN ('retry','quota') AND not_before<=${now} RETURNING id,tenant_id`;
    for (const tenant of new Set(rows.map((row) => row.tenant_id))) await this.sql`SELECT pg_notify('jobs_queued', ${tenant})`;
    return rows.map((row) => row.id);
  }

  async admissionStats(tenantId: string) {
    const rows = await this.sql<{ queued: string; oldest_created_at: string | null }[]>`SELECT count(*)::text AS queued,min(created_at)::text AS oldest_created_at FROM jobs WHERE tenant_id=${tenantId}::uuid AND status='queued'`;
    const row = rows[0]!;
    return { queued: Number(row.queued), oldestAgeMs: row.oldest_created_at === null ? 0 : Math.max(0, Date.now() - Number(row.oldest_created_at)) };
  }

  private async fenced(jobId: string, workerId: string, fence: number, values: { checkpoint: ReturnType<Sql["json"]>; status: string }) {
    const now = Date.now();
    const rows = await this.sql`UPDATE jobs SET checkpoint=${values.checkpoint},status=${values.status},updated_at=${now}
      WHERE id=${jobId} AND lease_owner=${workerId} AND fence=${fence} AND status IN ('leased','running') AND lease_until>${now} RETURNING id`;
    if (!rows.length) throw lostLease();
  }
}

function lostLease() { return new Error("job lease lost or fencing token is stale"); }
function isSql(value: unknown): value is Sql { return !!value && typeof value === "function" && typeof (value as Sql).begin === "function"; }
function decode<T extends JobDocument>(row: Record<string, unknown>): T {
  return {
    id: row.id, tenantId: row.tenant_id, sessionId: row.session_id, rootSessionId: row.root_session_id,
    parentJobId: row.parent_job_id ?? undefined, kind: row.kind, status: row.status, waitReason: row.wait_reason ?? undefined,
    priority: row.priority, attempt: row.attempt, maxAttempts: row.max_attempts, leaseOwner: row.lease_owner ?? undefined,
    leaseUntil: row.lease_until === null ? undefined : Number(row.lease_until), fence: Number(row.fence), input: row.input,
    checkpoint: row.checkpoint ?? undefined, result: row.result ?? undefined, error: row.error ?? undefined,
    cancelRequestedAt: row.cancel_requested_at === null ? undefined : Number(row.cancel_requested_at),
    idempotencyKey: row.idempotency_key ?? undefined, notBefore: Number(row.not_before), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
  } as T;
}
