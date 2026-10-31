import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

export interface BrowserCommandResponse {
  id: string;
  status: number;
  body: Record<string, unknown>;
}

export class BrowserBridge {
  private child: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<
    string,
    { resolve: (res: BrowserCommandResponse) => void; timer: NodeJS.Timeout }
  >();
  private seq = 0;
  private workerPath: string;

  constructor(workerPath?: string) {
    if (workerPath) {
      this.workerPath = workerPath;
    } else {
      const candidate = "/opt/oh/packages/sandboxd/browser-worker.mjs";
      if (fs.existsSync(candidate)) {
        this.workerPath = candidate;
      } else {
        const here = path.dirname(fileURLToPath(import.meta.url));
        this.workerPath = path.resolve(here, "../browser-worker.mjs");
      }
    }
  }

  private ensureWorker(): ChildProcessWithoutNullStreams | null {
    if (this.child && !this.child.killed) return this.child;
    if (!fs.existsSync(this.workerPath)) return null;
    try {
      const child = spawn(process.execPath, [this.workerPath], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      const rl = readline.createInterface({ input: child.stdout, terminal: false });
      rl.on("line", (line) => {
        if (!line.trim()) return;
        try {
          const msg = JSON.parse(line) as BrowserCommandResponse;
          const entry = this.pending.get(msg.id);
          if (entry) {
            clearTimeout(entry.timer);
            this.pending.delete(msg.id);
            entry.resolve(msg);
          }
        } catch {
          // ignore malformed stdout line
        }
      });
      child.on("exit", () => {
        this.child = null;
        for (const [id, entry] of this.pending.entries()) {
          clearTimeout(entry.timer);
          entry.resolve({
            id,
            status: 503,
            body: { error: "Playwright browser worker exited unexpectedly" },
          });
        }
        this.pending.clear();
      });
      this.child = child;
      return child;
    } catch {
      return null;
    }
  }

  async send(
    action: string,
    payload: Record<string, unknown> = {},
    timeoutMs = 20_000
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const child = this.ensureWorker();
    if (!child) {
      return { status: 503, body: { error: "browser-worker.mjs not found" } };
    }
    const id = `bw_${++this.seq}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ status: 504, body: { error: `Browser action ${action} timed out` } });
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (res) => resolve({ status: res.status, body: res.body }),
        timer,
      });
      child.stdin.write(`${JSON.stringify({ id, action, payload })}\n`);
    });
  }

  async close(): Promise<void> {
    if (this.child && !this.child.killed) {
      this.child.kill("SIGTERM");
      this.child = null;
    }
  }
}
