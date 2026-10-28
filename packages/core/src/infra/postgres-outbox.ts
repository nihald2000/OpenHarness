import type { Sql } from "postgres";
import type { EventBus, EventEnvelope } from "./contracts.ts";

/** Relay committed outbox rows at least once. Consumers de-duplicate by session/seq. */
export async function relayOutboxBatch<Event = unknown>(sql: Sql, bus: EventBus<Event>, limit = 250) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 5_000) throw new Error("outbox limit must be an integer from 1 to 5000");
  const rows = await sql<{ id: string; tenant_id: string; session_id: string; seq: string; at: string; data: Event }[]>`SELECT id,tenant_id,session_id,seq,at,data FROM event_outbox WHERE published_at IS NULL ORDER BY id LIMIT ${limit}`;
  let published = 0;
  for (const row of rows) {
    const envelope: EventEnvelope<Event> = { tenantId: row.tenant_id, sessionId: row.session_id, seq: Number(row.seq), at: Number(row.at), data: row.data };
    await bus.publish(envelope);
    await sql`UPDATE event_outbox SET published_at=${Date.now()} WHERE id=${row.id} AND published_at IS NULL`;
    published++;
  }
  return published;
}
