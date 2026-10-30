import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  LocalStateStore,
  PostgresStateStore,
  PostgresJobQueue,
} from "../packages/core/src/infra/index.ts";
import type { SqlQueryable } from "../packages/core/src/infra/postgres-migrations.ts";

test("Step 5 (R6, F5, F7): LocalStateStore handles 1,000 concurrent events without EPERM via events.jsonl + atomicWriteFileSync, and Postgres adapters fail closed without OPENHARNESS_POSTGRES=1 and execute real SQL", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-statestore-"));

  try {
    // 1. 1,000-event run on LocalStateStore
    const store = new LocalStateStore({ dataDir: tmpDir, maxRetainedEvents: 2000 });
    await store.saveSession("tenant_1", {
      id: "sess_1000",
      title: "High Frequency Run",
      agent: "assistant",
      model: "mock/demo",
      runtime: "local",
      status: "running",
      updatedAt: Date.now(),
    });

    await Promise.all(
      Array.from({ length: 1000 }, (_, i) =>
        store.appendEvent("tenant_1", "sess_1000", {
          type: "process.output",
          line: `Line ${i + 1}`,
        } as any)
      )
    );
    store.flush();

    assert.ok(fs.existsSync(path.join(tmpDir, "events.jsonl")), "events.jsonl must be written");
    assert.ok(fs.existsSync(path.join(tmpDir, "state.json")), "state.json must be written");

    // Re-open from disk and verify all 1,000 events replay in order
    const reloaded = new LocalStateStore({ dataDir: tmpDir, maxRetainedEvents: 2000 });
    const replayed = await reloaded.listEventsAfter("tenant_1", 0, "sess_1000");
    assert.equal(replayed.length, 1000);
    assert.equal(replayed[0]!.seq, 1);
    assert.equal(replayed[999]!.seq, 1000);

    // 2. PostgresStateStore & PostgresJobQueue fail closed without OPENHARNESS_POSTGRES=1
    assert.throws(
      () =>
        new PostgresStateStore({
          connectionString: "postgres://localhost:5432/oh",
          postgresEnabled: false,
        }),
      /OPENHARNESS_POSTGRES=1 is not enabled/
    );
    assert.throws(
      () =>
        new PostgresJobQueue({
          connectionString: "postgres://localhost:5432/oh",
          postgresEnabled: false,
        }),
      /OPENHARNESS_POSTGRES=1 is not enabled/
    );

    // 3. PostgresStateStore does NOT extend LocalStateStore and uses SQL queries
    assert.equal(
      Object.getPrototypeOf(PostgresStateStore.prototype) === LocalStateStore.prototype,
      false,
      "PostgresStateStore must not extend LocalStateStore"
    );

    const executedSql: string[] = [];
    const fakePool: SqlQueryable = {
      async query(sql: string, _params?: unknown[]) {
        executedSql.push(sql.trim());
        if (sql.includes("RETURNING seq")) return { rows: [{ seq: 42 }] };
        return { rows: [] };
      },
    };
    const pgStore = new PostgresStateStore({
      connectionString: "postgres://localhost:5432/oh",
      pool: fakePool,
      postgresEnabled: true,
    });
    const env = await pgStore.appendEvent("tenant_pg", "sess_pg", {
      type: "run.phase",
      phase: "planning",
    });
    assert.equal(env.seq, 42);
    assert.ok(executedSql.some((s) => s.startsWith("INSERT INTO events")));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
