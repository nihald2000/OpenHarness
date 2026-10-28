import postgres from "postgres";
import type { Sql } from "postgres";
import type { StateStore } from "./contracts.ts";

type Identified = { id: string };
type MessageShape<Part> = { info: { id: string }; parts: Part[] };

/** Postgres implementation of the tenant-scoped document API. Writes and their
 * event/outbox rows are committed together; tx() reuses one database transaction. */
export class PostgresStateStore<
  Session extends Identified & { updatedAt?: number; createdAt?: number; ownerId?: string; parentId?: string },
  Message extends MessageShape<Part>,
  Part = unknown,
  Event = unknown,
  Rule = unknown,
> implements StateStore<Session, Message, Part, Event, Rule> {
  private constructor(private readonly sql: Sql, private readonly owned: boolean, private readonly inTransaction = false) {}

  static connect<Session extends Identified & { updatedAt?: number; createdAt?: number; ownerId?: string; parentId?: string }, Message extends MessageShape<Part>, Part = unknown, Event = unknown, Rule = unknown>(url: string, options: postgres.Options<{}> = {}) {
    return new PostgresStateStore<Session, Message, Part, Event, Rule>(postgres(url, { max: 10, ...options }), true);
  }

  async close() { if (this.owned) await this.sql.end({ timeout: 5 }); }

  async tx<T>(fn: (tx: StateStore<Session, Message, Part, Event, Rule>) => Promise<T>): Promise<T> {
    return this.sql.begin(async (transaction) => fn(new PostgresStateStore<Session, Message, Part, Event, Rule>(transaction as Sql, false, true)));
  }

  async putSession(tenantId: string, session: Session) {
    const now = Date.now();
    const ownerId = session.ownerId ?? null;
    const rows = await this.sql`INSERT INTO sessions (id, tenant_id, owner_id, parent_id, status, data, created_at, updated_at)
      VALUES (${session.id}, ${tenantId}::uuid, ${ownerId}::uuid, ${session.parentId ?? null}, ${String((session as any).status ?? "created")}, ${this.sql.json(session)}, ${session.createdAt ?? now}, ${session.updatedAt ?? now})
      ON CONFLICT (id) DO UPDATE SET owner_id=EXCLUDED.owner_id, parent_id=EXCLUDED.parent_id, status=EXCLUDED.status, data=EXCLUDED.data, updated_at=EXCLUDED.updated_at
      WHERE sessions.tenant_id=EXCLUDED.tenant_id RETURNING id`;
    if (!rows.length) throw new Error("session belongs to another tenant");
    await this.sql`INSERT INTO session_seq (session_id, seq) VALUES (${session.id}, 0) ON CONFLICT (session_id) DO NOTHING`;
  }

  async getSession(tenantId: string, sessionId: string) {
    const rows = await this.sql<{ data: Session }[]>`SELECT data FROM sessions WHERE tenant_id=${tenantId}::uuid AND id=${sessionId}`;
    return rows[0]?.data;
  }

  async listSessions(input: { tenantId: string; ownerId?: string; limit: number; cursor?: string }) {
    const limit = bounded(input.limit, 1, 500, "limit");
    const rows = input.ownerId
      ? await this.sql<{ data: Session }[]>`SELECT data FROM sessions WHERE tenant_id=${input.tenantId}::uuid AND owner_id=${input.ownerId}::uuid AND parent_id IS NULL AND (${input.cursor ?? null}::text IS NULL OR (updated_at,id) < (SELECT updated_at,id FROM sessions WHERE tenant_id=${input.tenantId}::uuid AND id=${input.cursor ?? ""})) ORDER BY updated_at DESC,id DESC LIMIT ${limit}`
      : await this.sql<{ data: Session }[]>`SELECT data FROM sessions WHERE tenant_id=${input.tenantId}::uuid AND parent_id IS NULL AND (${input.cursor ?? null}::text IS NULL OR (updated_at,id) < (SELECT updated_at,id FROM sessions WHERE tenant_id=${input.tenantId}::uuid AND id=${input.cursor ?? ""})) ORDER BY updated_at DESC,id DESC LIMIT ${limit}`;
    return rows.map((row) => row.data);
  }

  async childSessions(tenantId: string, parentSessionId: string) {
    const rows = await this.sql<{ data: Session }[]>`SELECT data FROM sessions WHERE tenant_id=${tenantId}::uuid AND parent_id=${parentSessionId} ORDER BY created_at,id`;
    return rows.map((row) => row.data);
  }

  async deleteSession(tenantId: string, sessionId: string) {
    const rows = await this.sql`DELETE FROM sessions WHERE tenant_id=${tenantId}::uuid AND id=${sessionId} RETURNING id`;
    return rows.length > 0;
  }

  async putMessage(tenantId: string, sessionId: string, message: Message) {
    const now = Date.now();
    const data = { ...message, parts: [] };
    const rows = await this.sql`INSERT INTO messages (id,tenant_id,session_id,data,created_at) SELECT ${message.info.id},${tenantId}::uuid,${sessionId},${this.sql.json(data)},${now} WHERE EXISTS (SELECT 1 FROM sessions WHERE tenant_id=${tenantId}::uuid AND id=${sessionId})
      ON CONFLICT (id) DO UPDATE SET data=EXCLUDED.data WHERE messages.tenant_id=EXCLUDED.tenant_id AND messages.session_id=EXCLUDED.session_id RETURNING id`;
    if (!rows.length) throw new Error("session or message belongs to another tenant");
    for (const part of message.parts) await this.upsertPart(tenantId, sessionId, message.info.id, part);
  }

  async putPart(tenantId: string, sessionId: string, messageId: string, part: Part) { await this.putParts(tenantId, sessionId, messageId, [part]); }

  async putParts(tenantId: string, sessionId: string, messageId: string, parts: Part[]) {
    for (const part of parts) await this.upsertPart(tenantId, sessionId, messageId, part);
  }

  private async upsertPart(tenantId: string, sessionId: string, messageId: string, part: Part) {
    const id = partKey(part);
    const rows = await this.sql`INSERT INTO parts (id,tenant_id,session_id,message_id,data,updated_at)
      SELECT ${id},${tenantId}::uuid,${sessionId},${messageId},${this.sql.json(part)},${Date.now()}
      WHERE EXISTS (SELECT 1 FROM messages m JOIN sessions s ON s.id=m.session_id WHERE m.tenant_id=${tenantId}::uuid AND m.session_id=${sessionId} AND m.id=${messageId} AND s.tenant_id=${tenantId}::uuid)
      ON CONFLICT (tenant_id,message_id,id) DO UPDATE SET data=EXCLUDED.data,updated_at=EXCLUDED.updated_at RETURNING id`;
    if (!rows.length) throw new Error("message not found");
  }

  async getMessages(tenantId: string, sessionId: string) {
    const rows = await this.sql<{ data: Omit<Message, "parts">; parts: Part[] }[]>`SELECT m.data, COALESCE(jsonb_agg(p.data ORDER BY p.id) FILTER (WHERE p.id IS NOT NULL),'[]'::jsonb) AS parts
      FROM messages m LEFT JOIN parts p ON p.tenant_id=m.tenant_id AND p.message_id=m.id
      WHERE m.tenant_id=${tenantId}::uuid AND m.session_id=${sessionId} GROUP BY m.id ORDER BY m.id`;
    return rows.map((row) => ({ ...row.data, parts: row.parts }) as Message);
  }

  async appendEvents(tenantId: string, sessionId: string, events: Event[]) {
    if (!events.length) return [];
    const write = async (tx: Sql) => {
      const valid = await tx`SELECT id FROM sessions WHERE tenant_id=${tenantId}::uuid AND id=${sessionId} FOR UPDATE`;
      if (!valid.length) throw new Error("session not found");
      await tx`INSERT INTO session_seq (session_id,seq) VALUES (${sessionId},0) ON CONFLICT (session_id) DO NOTHING`;
      const seqRows = await tx<{ seq: string }[]>`UPDATE session_seq SET seq=seq+${events.length} WHERE session_id=${sessionId} RETURNING seq`;
      const last = Number(seqRows[0]!.seq);
      const first = last - events.length + 1;
      const assigned = events.map((event, index) => ({ seq: first + index, event }));
      for (const { seq, event } of assigned) {
        const at = Date.now();
        const type = event && typeof event === "object" && typeof (event as any).type === "string" ? (event as any).type as string : "event";
        const data = this.sql.json(event);
        await tx`INSERT INTO events (tenant_id,session_id,seq,at,type,data) VALUES (${tenantId}::uuid,${sessionId},${seq},${at},${type},${data})`;
        await tx`INSERT INTO event_outbox (tenant_id,session_id,seq,at,data) VALUES (${tenantId}::uuid,${sessionId},${seq},${at},${data})`;
      }
      return assigned.map((row) => row.seq);
    };
    return this.inTransaction ? write(this.sql) : this.sql.begin((tx) => write(tx as Sql));
  }

  async listEvents(tenantId: string, sessionId: string, afterSeq: number, limit: number) {
    const rows = await this.sql<{ seq: string; data: Event }[]>`SELECT seq,data FROM events WHERE tenant_id=${tenantId}::uuid AND session_id=${sessionId} AND seq>${afterSeq} ORDER BY seq LIMIT ${bounded(limit, 1, 10000, "event limit")}`;
    return rows.map((row) => ({ seq: Number(row.seq), event: row.data }));
  }

  async lastSeq(tenantId: string, sessionId: string) {
    const rows = await this.sql<{ seq: string | null }[]>`SELECT ss.seq FROM session_seq ss JOIN sessions s ON s.id=ss.session_id WHERE s.tenant_id=${tenantId}::uuid AND ss.session_id=${sessionId}`;
    return Number(rows[0]?.seq ?? 0);
  }

  async pruneEvents(olderThan: number) {
    const rows = await this.sql`DELETE FROM events e USING sessions s WHERE e.session_id=s.id AND e.tenant_id=s.tenant_id AND e.at<${olderThan} RETURNING e.seq`;
    await this.sql`DELETE FROM event_outbox WHERE at<${olderThan} AND published_at IS NOT NULL`;
    return rows.length;
  }

  async addRule(tenantId: string, sessionId: string | null, rule: Rule) {
    const value = rule && typeof rule === "object" ? rule as Record<string, unknown> : {};
    await this.sql`INSERT INTO permission_rules (tenant_id,session_id,permission,pattern,action,created_at)
      VALUES (${tenantId}::uuid,${sessionId},${String(value.permission ?? "")},${String(value.pattern ?? "")},${String(value.action ?? "")},${Date.now()})`;
  }

  async listRules(tenantId: string, sessionId?: string) {
    const rows = sessionId === undefined
      ? await this.sql<{ data: Rule }[]>`SELECT jsonb_build_object('permission',permission,'pattern',pattern,'action',action,'sessionId',session_id) AS data FROM permission_rules WHERE tenant_id=${tenantId}::uuid`
      : await this.sql<{ data: Rule }[]>`SELECT jsonb_build_object('permission',permission,'pattern',pattern,'action',action,'sessionId',session_id) AS data FROM permission_rules WHERE tenant_id=${tenantId}::uuid AND (session_id IS NULL OR session_id=${sessionId})`;
    return rows.map((row) => row.data);
  }
}

function bounded(value: number, min: number, max: number, name: string) {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer from ${min} to ${max}`);
  return value;
}

function partKey(value: unknown): string {
  if (!value || typeof value !== "object") return `value:${String(value)}`;
  const part = value as Record<string, unknown>;
  if (typeof part.callId === "string") return `call:${part.callId}`;
  if (typeof part.id === "string") return `id:${part.id}`;
  if (part.type === "text") return "text";
  if (part.type === "step") return "step";
  return `${String(part.type ?? "part")}:${JSON.stringify(part)}`;
}
