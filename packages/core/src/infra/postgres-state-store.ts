import type {
  CheckpointInfo,
  Message,
  OpenHarnessEvent,
  PermissionReply,
  PermissionRequest,
  RunRecord,
  ScheduleRecord,
  Session,
} from "@openharness/sdk";
import type { EventEnvelope, StateStore, StepCheckpoint } from "../agent/deps.ts";
import type { SqlQueryable } from "./postgres-migrations.ts";

export interface PostgresStateStoreOptions {
  connectionString: string;
  pool?: SqlQueryable;
  postgresEnabled?: boolean;
}

/**
 * Real SQL-backed PostgresStateStore using a SqlQueryable / pg.Pool connection.
 * Does NOT extend LocalStateStore; fails closed if OPENHARNESS_POSTGRES !== "1" when constructed from env.
 */
export class PostgresStateStore implements StateStore {
  readonly connectionString: string;
  private pool: SqlQueryable;

  constructor(opts: PostgresStateStoreOptions) {
    if (!opts.connectionString) {
      throw new Error("PostgresStateStore requires a connectionString (DATABASE_URL).");
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
      throw new Error("PostgresStateStore requires an active pg.Pool instance or SqlQueryable.");
    }
  }

  async getTenantSetting(tenantId: string, key: string): Promise<unknown | null> {
    const res = await this.pool.query(
      "SELECT value FROM tenant_settings WHERE tenant_id = $1 AND setting_key = $2",
      [tenantId, key]
    );
    if (res.rows.length === 0) return null;
    const value = res.rows[0].value;
    return typeof value === "string" ? JSON.parse(value) : value;
  }

  async setTenantSetting(tenantId: string, key: string, value: unknown): Promise<void> {
    await this.pool.query(
      `INSERT INTO tenant_settings (tenant_id, setting_key, value, updated_at)
       VALUES ($1, $2, $3::jsonb, $4)
       ON CONFLICT (tenant_id, setting_key) DO UPDATE SET
         value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
      [tenantId, key, JSON.stringify(value), Date.now()]
    );
  }

  async deleteTenantSetting(tenantId: string, key: string): Promise<void> {
    await this.pool.query(
      "DELETE FROM tenant_settings WHERE tenant_id = $1 AND setting_key = $2",
      [tenantId, key]
    );
  }

  async getSession(tenantId: string, sessionId: string): Promise<Session | null> {
    const res = await this.pool.query(
      "SELECT payload FROM sessions WHERE tenant_id = $1 AND id = $2",
      [tenantId, sessionId]
    );
    if (res.rows.length === 0) return null;
    return res.rows[0].payload as Session;
  }

  async saveSession(tenantId: string, session: Session): Promise<void> {
    const now = typeof session.updatedAt === "number" ? session.updatedAt : Date.now();
    await this.pool.query(
      `INSERT INTO sessions (id, tenant_id, title, status, mode, agent, model, runtime, created_at, updated_at, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (id) DO UPDATE SET
         title = EXCLUDED.title,
         status = EXCLUDED.status,
         mode = EXCLUDED.mode,
         agent = EXCLUDED.agent,
         model = EXCLUDED.model,
         runtime = EXCLUDED.runtime,
         updated_at = EXCLUDED.updated_at,
         payload = EXCLUDED.payload
       WHERE sessions.tenant_id = $2`,
      [
        session.id,
        tenantId,
        session.title ?? "Untitled",
        session.status ?? "idle",
        session.mode ?? "chat",
        session.agent ?? "assistant",
        session.model ?? "mock/demo",
        session.runtime ?? "local",
        now,
        now,
        JSON.stringify(session),
      ]
    );
  }

  async listSessions(tenantId: string, limit = 200): Promise<Session[]> {
    const res = await this.pool.query(
      "SELECT payload FROM sessions WHERE tenant_id = $1 ORDER BY updated_at DESC LIMIT $2",
      [tenantId, limit]
    );
    return res.rows.map((r) => r.payload as Session);
  }

  async deleteSession(tenantId: string, sessionId: string): Promise<void> {
    await this.pool.query(
      "DELETE FROM sessions WHERE tenant_id = $1 AND id = $2",
      [tenantId, sessionId]
    );
  }

  async getMessages(
    tenantId: string,
    sessionId: string
  ): Promise<{ messages: Message[]; lastSeq: number }> {
    const s = await this.getSession(tenantId, sessionId);
    const lastSeq = await this.getLastSeq(tenantId, sessionId);
    if (!s) return { messages: [], lastSeq };
    const msgs = ((s as any)._messages as Message[] | undefined) ?? [];
    return { messages: msgs, lastSeq };
  }

  async saveMessage(tenantId: string, sessionId: string, message: Message): Promise<void> {
    const s = await this.getSession(tenantId, sessionId);
    if (!s) throw new Error(`Session not found: ${sessionId}`);
    const list: Message[] = ((s as any)._messages as Message[] | undefined) ?? [];
    const idx = list.findIndex((m) => m.info.id === message.info.id);
    if (idx === -1) list.push(message);
    else list[idx] = message;
    (s as any)._messages = list;
    await this.saveSession(tenantId, s);
  }

  async replaceMessages(tenantId: string, sessionId: string, messages: Message[]): Promise<void> {
    const s = await this.getSession(tenantId, sessionId);
    if (!s) throw new Error(`Session not found: ${sessionId}`);
    (s as any)._messages = messages;
    await this.saveSession(tenantId, s);
  }

  async appendEvent(
    tenantId: string,
    sessionId: string,
    event: OpenHarnessEvent
  ): Promise<EventEnvelope> {
    const now = Date.now();
    const res = await this.pool.query(
      `INSERT INTO events (tenant_id, session_id, run_id, event_type, payload, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING seq`,
      [
        tenantId,
        sessionId,
        (event as any).runId ?? null,
        event.type,
        JSON.stringify(event),
        now,
      ]
    );
    const seq = Number(res.rows[0]?.seq ?? 1);
    return {
      seq,
      tenantId,
      sessionId,
      event,
      createdAt: now,
    };
  }

  async listEventsAfter(
    tenantId: string,
    afterSeq: number,
    sessionId?: string
  ): Promise<EventEnvelope[]> {
    const res = sessionId
      ? await this.pool.query(
          "SELECT seq, tenant_id, session_id, payload, created_at FROM events WHERE tenant_id = $1 AND seq > $2 AND session_id = $3 ORDER BY seq ASC",
          [tenantId, afterSeq, sessionId]
        )
      : await this.pool.query(
          "SELECT seq, tenant_id, session_id, payload, created_at FROM events WHERE tenant_id = $1 AND seq > $2 ORDER BY seq ASC",
          [tenantId, afterSeq]
        );
    return res.rows.map((r) => ({
      seq: Number(r.seq),
      tenantId: String(r.tenant_id),
      sessionId: String(r.session_id ?? ""),
      event: typeof r.payload === "string" ? JSON.parse(r.payload) : r.payload,
      createdAt: Number(r.created_at),
    }));
  }

  async getLastSeq(tenantId: string, _sessionId?: string): Promise<number> {
    const res = await this.pool.query(
      "SELECT COALESCE(MAX(seq), 0) AS max_seq FROM events WHERE tenant_id = $1",
      [tenantId]
    );
    return Number(res.rows[0]?.max_seq ?? 0);
  }

  async saveStepCheckpoint(checkpoint: StepCheckpoint): Promise<void> {
    await this.pool.query(
      `INSERT INTO run_steps (run_id, step, phase, fence_token, sandbox_handle_id, state_json, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (run_id, step) DO UPDATE SET
         phase = EXCLUDED.phase,
         fence_token = EXCLUDED.fence_token,
         state_json = EXCLUDED.state_json`,
      [
        checkpoint.runId,
        checkpoint.stepIndex,
        checkpoint.state.phase,
        0,
        checkpoint.sandboxHandleId,
        JSON.stringify(checkpoint),
        Date.now(),
      ]
    );
  }

  async getStepCheckpoint(tenantId: string, runId: string): Promise<StepCheckpoint | null> {
    const res = await this.pool.query(
      `SELECT rs.state_json FROM run_steps rs
       JOIN runs r ON r.run_id = rs.run_id
       WHERE rs.run_id = $1 AND r.tenant_id = $2
       ORDER BY rs.step DESC LIMIT 1`,
      [runId, tenantId]
    );
    if (res.rows.length === 0) return null;
    const cp = (typeof res.rows[0].state_json === "string"
      ? JSON.parse(res.rows[0].state_json)
      : res.rows[0].state_json) as StepCheckpoint;
    if (cp.tenantId !== tenantId) return null;
    return cp;
  }

  async saveRun(tenantId: string, run: RunRecord): Promise<void> {
    const now = Date.now();
    await this.pool.query(
      `INSERT INTO runs (run_id, session_id, tenant_id, phase, mode, iteration, payload, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (run_id) DO UPDATE SET
         phase = EXCLUDED.phase,
         iteration = EXCLUDED.iteration,
         payload = EXCLUDED.payload,
         updated_at = EXCLUDED.updated_at
       WHERE runs.tenant_id = $3`,
      [
        run.id,
        run.sessionId,
        tenantId,
        run.phase,
        run.mode,
        run.iteration ?? 0,
        JSON.stringify(run),
        now,
        now,
      ]
    );
  }

  async getRun(tenantId: string, runId: string): Promise<RunRecord | null> {
    const res = await this.pool.query(
      "SELECT payload FROM runs WHERE tenant_id = $1 AND run_id = $2",
      [tenantId, runId]
    );
    if (res.rows.length === 0) return null;
    return (typeof res.rows[0].payload === "string"
      ? JSON.parse(res.rows[0].payload)
      : res.rows[0].payload) as RunRecord;
  }

  async listRuns(tenantId: string): Promise<RunRecord[]> {
    const res = await this.pool.query(
      "SELECT payload FROM runs WHERE tenant_id = $1 ORDER BY updated_at DESC",
      [tenantId]
    );
    return res.rows.map((row) =>
      (typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload) as RunRecord
    );
  }

  async saveSchedule(tenantId: string, schedule: ScheduleRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO schedules (schedule_id, tenant_id, payload, updated_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, schedule_id) DO UPDATE
       SET payload = EXCLUDED.payload, updated_at = EXCLUDED.updated_at`,
      [schedule.id, tenantId, JSON.stringify(schedule), Date.now()]
    );
  }

  async getSchedule(tenantId: string, id: string): Promise<ScheduleRecord | null> {
    const res = await this.pool.query(
      "SELECT payload FROM schedules WHERE tenant_id = $1 AND schedule_id = $2",
      [tenantId, id]
    );
    if (res.rows.length === 0) return null;
    return (typeof res.rows[0].payload === "string" ? JSON.parse(res.rows[0].payload) : res.rows[0].payload) as ScheduleRecord;
  }

  async listSchedules(tenantId: string): Promise<ScheduleRecord[]> {
    const res = await this.pool.query(
      "SELECT payload FROM schedules WHERE tenant_id = $1 ORDER BY updated_at DESC",
      [tenantId]
    );
    return res.rows.map((row) =>
      (typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload) as ScheduleRecord
    );
  }

  async deleteSchedule(tenantId: string, id: string): Promise<void> {
    await this.pool.query(
      "DELETE FROM schedules WHERE tenant_id = $1 AND schedule_id = $2",
      [tenantId, id]
    );
  }

  async savePermissionRequest(tenantId: string, req: PermissionRequest): Promise<void> {
    const s = await this.getSession(tenantId, req.sessionId);
    if (!s) return;
    const perms = ((s as any)._permissions as PermissionRequest[] | undefined) ?? [];
    perms.push(req);
    (s as any)._permissions = perms;
    await this.saveSession(tenantId, s);
  }

  async getPermissionRequest(
    tenantId: string,
    requestId: string
  ): Promise<PermissionRequest | null> {
    const sessions = await this.listSessions(tenantId);
    for (const s of sessions) {
      const perms = ((s as any)._permissions as PermissionRequest[] | undefined) ?? [];
      const found = perms.find((p) => p.id === requestId);
      if (found) return found;
    }
    return null;
  }

  async listPermissionRequests(
    tenantId: string,
    sessionId?: string
  ): Promise<PermissionRequest[]> {
    const sessions = sessionId
      ? ([await this.getSession(tenantId, sessionId)].filter(Boolean) as Session[])
      : await this.listSessions(tenantId);
    const out: PermissionRequest[] = [];
    for (const s of sessions) {
      const perms = ((s as any)._permissions as Array<PermissionRequest & { reply?: string }> | undefined) ?? [];
      for (const p of perms) {
        if (!p.reply) out.push(p);
      }
    }
    return out;
  }

  async resolvePermissionRequest(
    tenantId: string,
    requestId: string,
    reply: PermissionReply
  ): Promise<PermissionRequest | null> {
    const sessions = await this.listSessions(tenantId);
    for (const s of sessions) {
      const perms = ((s as any)._permissions as Array<PermissionRequest & { reply?: string }> | undefined) ?? [];
      const found = perms.find((p) => p.id === requestId);
      if (found) {
        found.reply = reply;
        await this.saveSession(tenantId, s);
        return found;
      }
    }
    return null;
  }

  async saveCheckpointInfo(
    tenantId: string,
    sessionId: string,
    checkpoint: CheckpointInfo
  ): Promise<void> {
    const s = await this.getSession(tenantId, sessionId);
    if (!s) return;
    const cps = ((s as any)._checkpoints as CheckpointInfo[] | undefined) ?? [];
    if (!cps.some((c) => c.sha === checkpoint.sha)) cps.push(checkpoint);
    (s as any)._checkpoints = cps;
    await this.saveSession(tenantId, s);
  }

  async listCheckpoints(tenantId: string, sessionId: string): Promise<CheckpointInfo[]> {
    const s = await this.getSession(tenantId, sessionId);
    if (!s) return [];
    return ((s as any)._checkpoints as CheckpointInfo[] | undefined) ?? [];
  }
}
