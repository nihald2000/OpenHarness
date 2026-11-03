import { EventEmitter } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

export interface BrowserBridgeOptions {
  runAs?: { uid: number; gid: number };
  homePath?: string;
  tmpPath?: string;
  workerPath?: string;
}

export interface BrowserCommandResponse {
  id: string;
  status: number;
  body: Record<string, unknown>;
}

export class BrowserBridge extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<
    string,
    { resolve: (res: BrowserCommandResponse) => void; timer: NodeJS.Timeout }
  >();
  private seq = 0;
  private workerPath: string;
  private readonly opts: BrowserBridgeOptions;

  constructor(opts: BrowserBridgeOptions | string = {}) {
    super();
    this.opts = typeof opts === "string" ? { workerPath: opts } : opts;
    if (this.opts.workerPath) {
      this.workerPath = this.opts.workerPath;
    } else {
      const here = path.dirname(fileURLToPath(import.meta.url));
      const candidates = [
        "/opt/oh/packages/sandboxd/browser-worker.mjs",
        "/opt/oh/browser-worker.mjs",
        path.resolve(here, "../browser-worker.mjs"),
      ];
      this.workerPath = candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0]!;
    }
  }

  private ensureWorker(): ChildProcessWithoutNullStreams | null {
    if (this.child && !this.child.killed) return this.child;
    if (!fs.existsSync(this.workerPath)) return null;
    try {
      const tmpPath = this.opts.tmpPath ?? "/tmp";
      const env: NodeJS.ProcessEnv = {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        HOME: this.opts.homePath ?? "/tmp",
        TMPDIR: tmpPath,
        LANG: "C.UTF-8",
        PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH ?? "/ms-playwright",
        ...(process.env.CHROMIUM_EXECUTABLE_PATH ? { CHROMIUM_EXECUTABLE_PATH: process.env.CHROMIUM_EXECUTABLE_PATH } : {}),
        NODE_PATH: process.env.NODE_PATH ?? "/opt/oh/node_modules",
      };
      const drop = this.opts.runAs && process.platform === "linux" && process.getuid?.() === 0
        ? ["setpriv", "--reuid", String(this.opts.runAs.uid), "--regid", String(this.opts.runAs.gid), "--clear-groups", "--no-new-privs", "--"]
        : [];
      const argv = [...drop, process.execPath, this.workerPath];
      const child = spawn(argv[0]!, argv.slice(1), {
        stdio: ["pipe", "pipe", "pipe"],
        env,
        cwd: tmpPath,
      });
      const rl = readline.createInterface({ input: child.stdout, terminal: false });
      rl.on("line", (line) => {
        if (!line.trim()) return;
        try {
          const msg = JSON.parse(line) as BrowserCommandResponse & { event?: string };
          if (msg.event) {
            this.emit(msg.event, msg);
            return;
          }
          const entry = this.pending.get(msg.id);
          if (entry) {
            clearTimeout(entry.timer);
            this.pending.delete(msg.id);
            entry.resolve(msg);
          }
        } catch {
          // Ignore malformed worker output; stdout must remain machine-readable.
        }
      });
      child.on("exit", () => {
        this.child = null;
        for (const [id, entry] of this.pending.entries()) {
          clearTimeout(entry.timer);
          entry.resolve({ id, status: 503, body: { error: "Playwright browser worker exited unexpectedly" } });
        }
        this.pending.clear();
      });
      child.stderr.on("data", (chunk: Buffer | string) => this.emit("stderr", String(chunk).slice(0, 2_000)));
      this.child = child;
      return child;
    } catch {
      return null;
    }
  }

  async isAvailable(): Promise<boolean> {
    const response = await this.send("health", {}, 5_000);
    return response.status === 200;
  }

  async send(action: string, payload: Record<string, unknown> = {}, timeoutMs = 20_000): Promise<{ status: number; body: Record<string, unknown> }> {
    const child = this.ensureWorker();
    if (!child) return { status: 503, body: { error: "browser-worker.mjs not found" } };
    const id = `bw_${++this.seq}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ status: 504, body: { error: `Browser action ${action} timed out` } });
      }, timeoutMs);
      this.pending.set(id, { resolve: (res) => resolve({ status: res.status, body: res.body }), timer });
      child.stdin.write(`${JSON.stringify({ id, action, payload })}\n`);
    });
  }

  post(action: string, payload: Record<string, unknown> = {}): void {
    const child = this.ensureWorker();
    if (!child || child.stdin.destroyed) return;
    child.stdin.write(`${JSON.stringify({ action, payload })}\n`);
  }

  async close(): Promise<void> {
    if (this.child && !this.child.killed) {
      this.child.kill("SIGTERM");
      this.child = null;
    }
  }
}
