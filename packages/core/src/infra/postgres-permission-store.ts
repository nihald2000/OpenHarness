import postgres from "postgres";
import type { Sql } from "postgres";
import type { PermissionDecision, PermissionRequestDocument, PermissionStore } from "./contracts.ts";

/** Tenant-scoped durable approvals. Replies and saved rules commit atomically. */
export class PostgresPermissionStore implements PermissionStore {
  private constructor(private readonly sql: Sql, private readonly owned: boolean) {}
  static connect(url: string, options: postgres.Options<{}> = {}) {
    return new PostgresPermissionStore(postgres(url, { max: 10, ...options }), true);
  }
  async close() { if (this.owned) await this.sql.end({ timeout: 5 }); }

  async create(request: PermissionRequestDocument) {
    const rows = await this.sql`INSERT INTO permission_requests
      (id,tenant_id,session_id,job_id,message_id,call_id,permission,patterns,title,metadata,rules,status,created_at)
      SELECT ${request.id},${request.tenantId}::uuid,${request.sessionId},${request.jobId},${request.messageId},${request.callId},${request.permission},${this.sql.json(request.patterns)},${request.title},${this.sql.json(request.metadata)},${this.sql.json(request.rules)},'pending',${request.createdAt}
      WHERE EXISTS (SELECT 1 FROM sessions WHERE tenant_id=${request.tenantId}::uuid AND id=${request.sessionId}) RETURNING id`;
    if (!rows.length) throw new Error("session not found");
  }

  async getPending(tenantId: string, requestId: string) {
    const rows = await this.sql`SELECT * FROM permission_requests WHERE tenant_id=${tenantId}::uuid AND id=${requestId} AND status='pending'`;
    return rows[0] ? decode(rows[0]) : undefined;
  }

  async listPending(tenantId: string, sessionId?: string) {
    const rows = sessionId === undefined
      ? await this.sql`SELECT * FROM permission_requests WHERE tenant_id=${tenantId}::uuid AND status='pending' ORDER BY created_at,id`
      : await this.sql`SELECT * FROM permission_requests WHERE tenant_id=${tenantId}::uuid AND session_id=${sessionId} AND status='pending' ORDER BY created_at,id`;
    return rows.map(decode);
  }

  async decide(tenantId: string, requestId: string, decision: PermissionDecision, repliedBy?: string) {
    return this.sql.begin(async (tx) => {
      const rows = await tx`SELECT * FROM permission_requests WHERE tenant_id=${tenantId}::uuid AND id=${requestId} AND status='pending' FOR UPDATE`;
      if (!rows.length) return undefined;
      const target = decode(rows[0]!);
      const status = decision === "reject" ? "rejected" : "allowed";
      const repliedAt = Date.now();
      const primaryRows = await tx`UPDATE permission_requests SET status=${status},reply=${decision},replied_by=${repliedBy ?? null}::uuid,replied_at=${repliedAt} WHERE tenant_id=${tenantId}::uuid AND id=${requestId} AND status='pending' RETURNING *`;
      const changed = [decode(primaryRows[0]!)];

      if (decision === "always") {
        for (const pattern of target.patterns) {
          await tx`INSERT INTO permission_rules (tenant_id,session_id,permission,pattern,action,created_at)
            VALUES (${tenantId}::uuid,${target.sessionId},${target.permission},${pattern},'always',${repliedAt}) ON CONFLICT DO NOTHING`;
        }
        // Existing pending calls covered by this exact permission/pattern are
        // released together, preserving each request's rules snapshot.
        const autoAllowed = await tx`UPDATE permission_requests p SET status='allowed',reply='always',replied_by=${repliedBy ?? null}::uuid,replied_at=${repliedAt}
          WHERE p.tenant_id=${tenantId}::uuid AND p.session_id=${target.sessionId} AND p.status='pending' AND p.id<>${requestId}
            AND p.permission=${target.permission} AND EXISTS (
              SELECT 1 FROM jsonb_array_elements_text(p.patterns) AS c(pattern)
              WHERE c.pattern = ANY(${target.patterns})
            ) RETURNING p.*`;
        changed.push(...autoAllowed.map(decode));
      } else if (decision === "reject") {
        const rejected = await tx`UPDATE permission_requests SET status='rejected',reply='reject',replied_by=${repliedBy ?? null}::uuid,replied_at=${repliedAt}
          WHERE tenant_id=${tenantId}::uuid AND session_id=${target.sessionId} AND status='pending' AND id<>${requestId} RETURNING *`;
        changed.push(...rejected.map(decode));
      }

      await writePermissionEvents(tx, tenantId, target.sessionId, changed, repliedAt);
      const jobIds = [...new Set(changed.map((request) => request.jobId))];
      for (const jobId of jobIds) {
        const pending = await tx`SELECT 1 FROM permission_requests WHERE tenant_id=${tenantId}::uuid AND job_id=${jobId} AND status='pending' LIMIT 1`;
        if (!pending.length) {
          const resumed = await tx`UPDATE jobs SET status='queued',wait_reason=NULL,not_before=${repliedAt},updated_at=${repliedAt}
            WHERE tenant_id=${tenantId}::uuid AND id=${jobId} AND status='waiting' AND wait_reason='approval' RETURNING tenant_id`;
          if (resumed.length) await tx`SELECT pg_notify('jobs_queued', ${tenantId})`;
        }
      }
      return { primary: changed[0]!, changed };
    });
  }

  async rejectSession(tenantId: string, sessionId: string, reply: "reject") {
    return this.sql.begin(async (tx) => {
      const at = Date.now();
      const rows = await tx`UPDATE permission_requests SET status='rejected',reply=${reply},replied_at=${at}
        WHERE tenant_id=${tenantId}::uuid AND session_id=${sessionId} AND status='pending' RETURNING *`;
      const requests = rows.map(decode);
      await writePermissionEvents(tx, tenantId, sessionId, requests, at);
      await tx`UPDATE jobs SET status='cancelled',cancel_requested_at=${at},wait_reason=NULL,lease_owner=NULL,lease_until=NULL,updated_at=${at}
        WHERE tenant_id=${tenantId}::uuid AND session_id=${sessionId} AND status IN ('queued','waiting')`;
      await tx`UPDATE jobs SET cancel_requested_at=${at},updated_at=${at} WHERE tenant_id=${tenantId}::uuid AND session_id=${sessionId} AND status IN ('leased','running')`;
      return requests;
    });
  }

  async expireBefore(tenantId: string, cutoff: number) {
    return this.sql.begin(async (tx) => {
      const at = Date.now();
      const rows = await tx`UPDATE permission_requests SET status='expired',reply='reject',replied_at=${at}
        WHERE tenant_id=${tenantId}::uuid AND status='pending' AND created_at<${cutoff} RETURNING *`;
      const requests = rows.map(decode);
      for (const sessionId of new Set(requests.map((request) => request.sessionId))) {
        const inSession = requests.filter((request) => request.sessionId === sessionId);
        await writePermissionEvents(tx, tenantId, sessionId, inSession, at);
      }
      for (const jobId of new Set(requests.map((request) => request.jobId))) {
        const pending = await tx`SELECT 1 FROM permission_requests WHERE tenant_id=${tenantId}::uuid AND job_id=${jobId} AND status='pending' LIMIT 1`;
        if (!pending.length) {
          const resumed = await tx`UPDATE jobs SET status='queued',wait_reason=NULL,not_before=${at},updated_at=${at}
            WHERE tenant_id=${tenantId}::uuid AND id=${jobId} AND status='waiting' AND wait_reason='approval' RETURNING tenant_id`;
          if (resumed.length) await tx`SELECT pg_notify('jobs_queued', ${tenantId})`;
        }
      }
      return requests;
    });
  }
}

async function writePermissionEvents(tx: Sql, tenantId: string, sessionId: string, requests: PermissionRequestDocument[], at: number) {
  if (!requests.length) return;
  await tx`INSERT INTO session_seq (session_id,seq) VALUES (${sessionId},0) ON CONFLICT (session_id) DO NOTHING`;
  const rows = await tx<{ seq: string }[]>`UPDATE session_seq SET seq=seq+${requests.length} WHERE session_id=${sessionId} RETURNING seq`;
  const last = Number(rows[0]!.seq);
  const first = last - requests.length + 1;
  for (let index = 0; index < requests.length; index++) {
    const request = requests[index]!;
    const event = { type: "permission.replied", requestId: request.id, reply: request.reply ?? "reject", sessionId };
    const seq = first + index;
    await tx`INSERT INTO events (tenant_id,session_id,seq,at,type,data) VALUES (${tenantId}::uuid,${sessionId},${seq},${at},'permission.replied',${tx.json(event)})`;
    await tx`INSERT INTO event_outbox (tenant_id,session_id,seq,at,data) VALUES (${tenantId}::uuid,${sessionId},${seq},${at},${tx.json(event)})`;
  }
}

function decode(row: Record<string, unknown>): PermissionRequestDocument {
  return {
    id: String(row.id), tenantId: String(row.tenant_id), sessionId: String(row.session_id), jobId: String(row.job_id),
    messageId: String(row.message_id), callId: String(row.call_id), permission: String(row.permission),
    patterns: Array.isArray(row.patterns) ? row.patterns.map(String) : [], title: String(row.title),
    metadata: row.metadata && typeof row.metadata === "object" ? row.metadata as Record<string, unknown> : {},
    rules: Array.isArray(row.rules) ? row.rules : [], status: row.status as PermissionRequestDocument["status"],
    reply: row.reply === "once" || row.reply === "always" || row.reply === "reject" ? row.reply : undefined,
    createdAt: Number(row.created_at), repliedAt: row.replied_at === null ? undefined : Number(row.replied_at),
  };
}
