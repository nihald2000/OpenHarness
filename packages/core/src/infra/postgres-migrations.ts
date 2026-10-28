import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Sql } from "postgres";

/** Apply numbered SQL migrations once, in lexical order, inside transactions. */
export async function runPostgresMigrations(sql: Sql, directory: string) {
  await sql`CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at bigint NOT NULL)`;
  const files = (await readdir(directory)).filter((file) => /^\d+_[a-z0-9_-]+\.sql$/i.test(file)).sort();
  const applied: string[] = [];
  for (const file of files) {
    const prior = await sql`SELECT version FROM schema_migrations WHERE version=${file}`;
    if (prior.length) continue;
    const source = await readFile(join(directory, file), "utf8");
    await sql.begin(async (tx) => {
      const check = await tx`SELECT version FROM schema_migrations WHERE version=${file} FOR UPDATE`;
      if (check.length) return;
      await tx.unsafe(source);
      await tx`INSERT INTO schema_migrations (version,applied_at) VALUES (${file},${Date.now()})`;
    });
    applied.push(file);
  }
  await ensureEventPartitions(sql);
  return { applied };
}

/** Keep this month and the following two monthly partitions ahead of writes. */
export async function ensureEventPartitions(sql: Sql, from = new Date()) {
  for (let offset = 0; offset < 3; offset++) {
    const start = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + offset, 1));
    const end = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + offset + 1, 1));
    const name = `events_${start.getUTCFullYear()}_${String(start.getUTCMonth() + 1).padStart(2, "0")}`;
    await sql.unsafe(`CREATE TABLE IF NOT EXISTS ${name} PARTITION OF events FOR VALUES FROM (${start.getTime()}) TO (${end.getTime()})`);
  }
}
