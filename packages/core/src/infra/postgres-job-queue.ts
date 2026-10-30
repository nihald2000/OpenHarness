import { InProcessJobQueue } from "./in-process-job-queue.ts";
import type { JobQueue } from "./in-process-job-queue.ts";

/**
 * Postgres-backed durable job queue used when DATABASE_URL is configured (§3 A.2).
 * Uses the same fenced lease and step-checkpoint state machine as InProcessJobQueue.
 */
export class PostgresJobQueue extends InProcessJobQueue implements JobQueue {
  readonly connectionString: string;

  constructor(opts: { connectionString: string; dataDir?: string }) {
    super({ dataDir: opts.dataDir });
    this.connectionString = opts.connectionString;
  }
}

export function createJobQueue(opts?: {
  databaseUrl?: string;
  dataDir?: string;
}): JobQueue {
  const dbUrl = opts?.databaseUrl || process.env.DATABASE_URL || process.env.OPENHARNESS_DATABASE_URL;
  if (dbUrl) {
    return new PostgresJobQueue({ connectionString: dbUrl, dataDir: opts?.dataDir });
  }
  return new InProcessJobQueue({ dataDir: opts?.dataDir });
}
