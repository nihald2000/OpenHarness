import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface SqlQueryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }>;
}

export async function runPostgresMigrations(db: SqlQueryable, migrationsDir?: string): Promise<string[]> {
  const dir =
    migrationsDir ??
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../migrations");
  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at BIGINT NOT NULL
    )
  `);
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const applied: string[] = [];
  for (const file of files) {
    const existing = await db.query(
      "SELECT filename FROM schema_migrations WHERE filename = $1",
      [file]
    );
    if (existing.rows.length > 0) continue;
    const sql = fs.readFileSync(path.join(dir, file), "utf8");
    await db.query(sql);
    await db.query(
      "INSERT INTO schema_migrations (filename, applied_at) VALUES ($1, $2)",
      [file, Date.now()]
    );
    applied.push(file);
  }
  return applied;
}
