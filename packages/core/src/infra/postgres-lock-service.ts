import postgres from "postgres";
import type { Sql } from "postgres";
import type { LockService } from "./contracts.ts";

/** Transaction-scoped advisory locks coordinate leaders across API/worker pods. */
export class PostgresLockService implements LockService {
  private constructor(private readonly sql: Sql, private readonly owned: boolean) {}
  static connect(url: string, options: postgres.Options<{}> = {}) {
    return new PostgresLockService(postgres(url, { max: 10, ...options }), true);
  }
  async close() { if (this.owned) await this.sql.end({ timeout: 5 }); }

  async withLock<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
    if (!Number.isInteger(ttlMs) || ttlMs < 1) throw new Error("lock timeout must be a positive integer");
    return this.sql.begin(async (tx) => {
      await tx`SELECT set_config('lock_timeout', ${`${ttlMs}ms`}, true)`;
      await tx`SELECT pg_advisory_xact_lock(hashtext('openharness'),hashtext(${key}))`;
      return fn();
    });
  }

  async tryLeader(name: string, fn: () => Promise<void>): Promise<boolean> {
    let acquired = false;
    await this.sql.begin(async (tx) => {
      const rows = await tx<{ acquired: boolean }[]>`SELECT pg_try_advisory_xact_lock(hashtext('openharness-leader'),hashtext(${name})) AS acquired`;
      acquired = rows[0]?.acquired === true;
      if (acquired) await fn();
    });
    return acquired;
  }
}
