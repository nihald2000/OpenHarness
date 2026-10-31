import type { DurableRunWorker } from "./run-worker.ts";

export interface KeepaliveHandle {
  hold<T>(runId: string, task: () => Promise<T>): Promise<T>;
}

export interface RunLauncher {
  launch(runId: string): void;
  recoverInterruptedRuns(): Promise<string[]>;
}

export class InProcessLauncher implements RunLauncher {
  private readonly worker: DurableRunWorker;
  private readonly keepalive?: KeepaliveHandle;

  constructor(opts: { worker: DurableRunWorker; keepalive?: KeepaliveHandle }) {
    this.worker = opts.worker;
    this.keepalive = opts.keepalive;
  }

  launch(runId: string): void {
    const runTask = () => this.worker.startRun(runId);
    if (this.keepalive) {
      void this.keepalive.hold(runId, runTask);
    } else {
      void runTask();
    }
  }

  async recoverInterruptedRuns(): Promise<string[]> {
    const active = this.worker.stateMachine.listActiveRuns();
    const recovered: string[] = [];
    for (const run of active) {
      if (
        run.status === "queued" ||
        run.status === "running" ||
        run.status === "verifying"
      ) {
        recovered.push(run.id);
        this.launch(run.id);
      }
    }
    return recovered;
  }
}
