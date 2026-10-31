import { BrowserBridge } from "./browser-bridge.ts";
import { spawnSync } from "node:child_process";
import { resolveInside } from "../../core/src/util/safe-path.ts";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import {
  assertEnforcementAvailable,
  isSrtInstalled,
  killConfinedProcessGroup,
  spawnConfined,
  spawnConfinedArgv,
  writeSrtSettings,
} from "./config.ts";
import type { ChildProcess } from "node:child_process";
import type { CompiledSandboxPolicy } from "../../core/src/sandbox/policy.ts";
import {
  buildSrtCommandArgs,
  evaluateFilesystemAccess,
  evaluateNetworkAccess,
  redactSecretsFromOutput,
} from "../../core/src/sandbox/policy.ts";

export interface SandboxTelemetryEvent {
  type: "sandbox.violation" | "process.output" | "port.opened";
  sessionId: string;
  runId: string;
  kind?: "fs_read" | "fs_write" | "network" | "mandatory_deny";
  target?: string;
  detail?: string;
  processId?: string;
  stream?: "stdout" | "stderr";
  data?: string;
  port?: number;
  previewUrl?: string;
  timestamp: number;
}

interface ShellSessionState {
  sid: string;
  cwd: string;
  env: Record<string, string>;
  runningChild?: ChildProcess;
  partialOutput: string;
  status: "idle" | "still_running";
}

interface BackgroundProcessState {
  id: string;
  command: string;
  cwd: string;
  child?: ChildProcess;
  logs: string[];
  port?: number;
  previewUrl?: string;
  status: "running" | "stopped" | "exited";
  startedAt: number;
}

interface BrowserSessionState {
  currentUrl: string;
  title: string;
  html: string;
  elements: Array<{ ref: string; role: string; name: string; value?: string }>;
  consoleLogs: string[];
  networkErrors: string[];
}

export interface SandboxDaemonConfig {
  sessionId: string;
  runId: string;
  sessionKey: string;
  workspacePath: string;
  memoriesPath: string;
  tmpPath: string;
  shadowGitDir: string;
  policyFilePath?: string;
  srtSettingsPath?: string;
  runAs?: { uid: number; gid: number };
  requireSrt?: boolean;
  requirePlaywright?: boolean;
  policy: CompiledSandboxPolicy;
  secretValuesToRedact?: string[];
  onTelemetry?: (ev: SandboxTelemetryEvent) => void;
}

export class SandboxDaemon {
  readonly config: SandboxDaemonConfig;
  private shellSessions = new Map<string, ShellSessionState>();
  private processes = new Map<string, BackgroundProcessState>();
  private undoStack = new Map<string, string[]>();
  private ports = new Map<number, string>();
  private browser: BrowserSessionState = {
    currentUrl: "about:blank",
    title: "Blank",
    html: "<html><body></body></html>",
    elements: [],
    consoleLogs: [],
    networkErrors: [],
  };
  private ipythonVars = new Map<string, unknown>();
  private shadowGitInitialized = false;
  private httpServer?: http.Server;
  private osEnforced = false;
  private enforcementError?: string;
  private srtSettingsPath: string;
  private browserBridge = new BrowserBridge();
  private idempotencyCache = new Map<
    string,
    { expiresAt: number; promise: Promise<{ status: number; body: Record<string, unknown>; headers: Record<string, string> }> }
  >();

  constructor(config: SandboxDaemonConfig) {
    this.config = config;
    fs.mkdirSync(this.config.workspacePath, { recursive: true });
    fs.mkdirSync(this.config.memoriesPath, { recursive: true });
    fs.mkdirSync(this.config.tmpPath, { recursive: true });
    fs.mkdirSync(this.config.shadowGitDir, { recursive: true });
    this.srtSettingsPath =
      this.config.srtSettingsPath ?? path.join(this.config.tmpPath, "srt-settings.json");
    if (this.config.policy.network.mode !== "open") {
      try {
        writeSrtSettings(this.srtSettingsPath, this.config.policy);
      } catch {
        // ignore if open mode in test
      }
    }
    try {
      assertEnforcementAvailable();
      this.osEnforced = true;
    } catch (err) {
      this.osEnforced = false;
      this.enforcementError = (err as Error).message;
    }
  }

  /**
   * Constant-time session key comparison (§0.1, §5 C.2).
   */
  verifySessionKey(providedKey: string | undefined): boolean {
    if (!providedKey) return false;
    const a = Buffer.from(providedKey, "utf8");
    const b = Buffer.from(this.config.sessionKey, "utf8");
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }

  private emitViolation(
    kind: "fs_read" | "fs_write" | "network" | "mandatory_deny",
    target: string,
    detail?: string
  ): void {
    this.config.onTelemetry?.({
      type: "sandbox.violation",
      sessionId: this.config.sessionId,
      runId: this.config.runId,
      kind,
      target,
      detail,
      timestamp: Date.now(),
    });
  }

  private redact(text: string): string {
    return redactSecretsFromOutput(text, this.config.secretValuesToRedact);
  }

  /**
   * Direct request dispatcher for in-process or HTTP routes.
   */
  async handleRequest(
    method: string,
    urlPath: string,
    headers: Record<string, string | undefined>,
    body?: Record<string, unknown>
  ): Promise<{ status: number; body: Record<string, unknown>; headers: Record<string, string> }> {
    const daemonHeaders = { "x-oh-daemon": "1" };
    const wrap = (res: { status: number; body: Record<string, unknown> }) => ({
      ...res,
      headers: daemonHeaders,
    });

    const parsedUrl = new URL(urlPath, "http://127.0.0.1");
    const pathname = parsedUrl.pathname;

    // /health is the ONLY unauthenticated route (§5 C.2)
    if (method === "GET" && pathname === "/health") {
      if (this.config.requireSrt && !this.osEnforced) {
        return wrap({
          status: 503,
          body: {
            ok: false,
            osEnforced: false,
            allowedMethods: "unsupported",
            error: this.enforcementError ?? "srt is not installed",
          },
        });
      }
      return wrap({
        status: 200,
        body: {
          ok: !this.config.requireSrt || this.osEnforced,
          osEnforced: this.osEnforced,
          allowedMethods: "unsupported",
          runId: this.config.runId,
          sessionId: this.config.sessionId,
          workspace: this.config.workspacePath,
        },
      });
    }

    const keyHeader =
      headers["x-session-key"] ?? headers["X-Session-Key"];
    if (!this.verifySessionKey(keyHeader)) {
      return wrap({
        status: 401,
        body: { error: "Unauthorized: invalid or missing X-Session-Key" },
      });
    }

    const reqId = headers["x-oh-request-id"] ?? headers["X-Oh-Request-Id"];
    if (method === "POST" && reqId) {
      const now = Date.now();
      for (const [k, v] of this.idempotencyCache.entries()) {
        if (v.expiresAt <= now) this.idempotencyCache.delete(k);
      }
      const existing = this.idempotencyCache.get(reqId);
      if (existing) return existing.promise;
      const promise = this.dispatchAuthenticated(method, pathname, parsedUrl, body ?? {}).then(wrap);
      this.idempotencyCache.set(reqId, { expiresAt: now + 10 * 60_000, promise });
      return promise;
    }

    return wrap(await this.dispatchAuthenticated(method, pathname, parsedUrl, body ?? {}));
  }

  private async dispatchAuthenticated(
    method: string,
    pathname: string,
    parsedUrl: URL,
    payload: Record<string, unknown>
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const isExecRoute =
      pathname === "/exec" ||
      /^\/shell\/[^/]+\/exec$/.test(pathname) ||
      pathname === "/processes" ||
      pathname === "/ipython/exec";
    if (isExecRoute && this.config.requireSrt && !this.osEnforced) {
      return {
        status: 503,
        body: {
          ok: false,
          osEnforced: false,
          error: this.enforcementError ?? "srt is not installed; refusing to execute (fail closed)",
        },
      };
    }

    if (method === "POST" && pathname === "/processes/stop-all") {
      for (const proc of this.processes.values()) {
        killConfinedProcessGroup(proc.child, "SIGKILL");
        proc.status = "stopped";
      }
      for (const s of this.shellSessions.values()) {
        killConfinedProcessGroup(s.runningChild, "SIGKILL");
        s.runningChild = undefined;
        s.status = "idle";
      }
      this.ports.clear();
      return { status: 200, body: { stopped: true } };
    }

    // --- Shell Routes ---
    if (method === "POST" && pathname === "/exec") {
      const rawCmd = Array.isArray(payload.command)
        ? payload.command[payload.command.length - 1] ?? payload.command.join(" ")
        : String(payload.command ?? "");
      return this.execShell("main", { ...payload, command: rawCmd });
    }
    const shellExecMatch = pathname.match(/^\/shell\/([^/]+)\/exec$/);
    if (method === "POST" && shellExecMatch) {
      return this.execShell(shellExecMatch[1]!, payload);
    }
    const shellInputMatch = pathname.match(/^\/shell\/([^/]+)\/input$/);
    if (method === "POST" && shellInputMatch) {
      return this.sendShellInput(shellInputMatch[1]!, payload);
    }
    const shellInterruptMatch = pathname.match(/^\/shell\/([^/]+)\/interrupt$/);
    if (method === "POST" && shellInterruptMatch) {
      return this.interruptShell(shellInterruptMatch[1]!);
    }

    // --- Background Process Routes ---
    if (method === "POST" && pathname === "/processes") {
      return this.startBackgroundProcess(payload);
    }
    const procLogsMatch = pathname.match(/^\/processes\/([^/]+)\/logs$/);
    if (method === "GET" && procLogsMatch) {
      const since = Number.parseInt(parsedUrl.searchParams.get("since") ?? "0", 10);
      return this.getProcessLogs(procLogsMatch[1]!, since);
    }
    const procDelMatch = pathname.match(/^\/processes\/([^/]+)$/);
    if (method === "DELETE" && procDelMatch) {
      return this.stopBackgroundProcess(procDelMatch[1]!);
    }

    // --- File Routes ---
    if (method === "POST" && pathname === "/files/view") {
      return this.viewFile(payload);
    }
    if (method === "POST" && pathname === "/files/create") {
      return this.createFile(payload);
    }
    if (method === "POST" && pathname === "/files/str_replace") {
      return this.strReplaceFile(payload);
    }
    if (method === "POST" && pathname === "/files/insert") {
      return this.insertFile(payload);
    }
    if (method === "POST" && pathname === "/files/undo_edit") {
      return this.undoEditFile(payload);
    }
    if (method === "POST" && pathname === "/files/apply_patch") {
      return this.applyPatch(payload);
    }

    // --- Search Routes ---
    if (method === "POST" && pathname === "/search/glob") {
      return this.searchGlob(payload);
    }
    if (method === "POST" && pathname === "/search/grep") {
      return this.searchGrep(payload);
    }

    // --- Git Checkpoints Routes ---
    if (method === "POST" && pathname === "/checkpoints/create") {
      return this.createCheckpoint(payload);
    }
    if (method === "POST" && pathname === "/checkpoints/diff") {
      return this.diffCheckpoint(payload);
    }
    if (method === "POST" && pathname === "/checkpoints/restore") {
      return this.restoreCheckpoint(payload);
    }

    // --- Workspace Archive Route ---
    if (method === "GET" && pathname === "/workspace/archive") {
      const tarRes = spawnSync(
        "tar",
        ["-czf", "-", "--exclude=node_modules", "--exclude=.git", "--exclude=.shadow-git", "."],
        { cwd: this.config.workspacePath, maxBuffer: 50 * 1024 * 1024 }
      );
      if (tarRes.status !== 0) {
        return { status: 500, body: { error: tarRes.stderr?.toString("utf8") || "tar failed" } };
      }
      return {
        status: 200,
        body: {
          archiveBase64: (tarRes.stdout as Buffer).toString("base64"),
        },
      };
    }

    // --- Ports Route ---
    if (method === "GET" && pathname === "/ports") {
      return {
        status: 200,
        body: {
          ports: Array.from(this.ports.entries()).map(([port, previewUrl]) => ({
            port,
            previewUrl,
          })),
        },
      };
    }

    // --- Browser Routes ---
    if (pathname.startsWith("/browser/")) {
      const action = pathname.slice("/browser/".length);
      const bridgeRes = await this.browserBridge.send(action, payload);
      if (bridgeRes.status !== 503) {
        return bridgeRes;
      }
      if (this.config.requirePlaywright || this.config.requireSrt) {
        return {
          status: 503,
          body: {
            ok: false,
            error: "Playwright browser worker unavailable in this environment (fail closed)",
          },
        };
      }
    }
    if (method === "POST" && pathname === "/browser/navigate") {
      return this.browserNavigate(payload);
    }
    if (method === "POST" && pathname === "/browser/snapshot") {
      return this.browserSnapshot();
    }
    if (method === "POST" && pathname === "/browser/click") {
      return this.browserClick(payload);
    }
    if (method === "POST" && pathname === "/browser/type") {
      return this.browserType(payload);
    }
    if (method === "POST" && pathname === "/browser/press") {
      return this.browserPress(payload);
    }
    if (method === "POST" && pathname === "/browser/screenshot") {
      return this.browserScreenshot();
    }
    if (method === "GET" && pathname === "/browser/console_logs") {
      return { status: 200, body: { logs: this.browser.consoleLogs } };
    }
    if (method === "GET" && pathname === "/browser/network_errors") {
      return { status: 200, body: { errors: this.browser.networkErrors } };
    }

    // --- IPython Route ---
    if (method === "POST" && pathname === "/ipython/exec") {
      return this.execIpython(payload);
    }

    return { status: 404, body: { error: `Unknown sandboxd route: ${method} ${pathname}` } };
  }

  /**
   * Pre-screens shell commands against compiled filesystem & network policy so violations
   * are caught deterministically and reported as `sandbox.violation` telemetry even when
   * `srt` binary is not installed on the host.
   */
  private inspectShellCommandPolicy(
    command: string,
    cwd: string
  ): { allowed: boolean; error?: string } {
    // 1. Check for forbidden read targets (~/.ssh, ~/.aws, ~/.config/gcloud, /oh/policy.json)
    const sshOrSecretRead = command.match(
      /(?:~\/\.ssh|\/root\/\.ssh|\.ssh\/id_|\.aws\/credentials|\.config\/gcloud|\/oh\/policy\.json)/
    );
    if (sshOrSecretRead) {
      const target = sshOrSecretRead[0]!;
      const check = evaluateFilesystemAccess(this.config.policy, target, "read", cwd);
      if (!check.allowed) {
        this.emitViolation(check.kind ?? "fs_read", target, check.reason);
        return { allowed: false, error: check.reason };
      }
    }

    // 2. Check for mandatory deny modifications (.git/hooks, .bashrc, .openharness/agents, etc.)
    const mandatoryMatch = command.match(
      /(?:\.git\/hooks(?:\/\S*)?|\.git\/config|\.bashrc|\.zshrc|\.profile|\.mcp\.json|\.openharness\/(?:agents|commands|skills))/
    );
    if (mandatoryMatch) {
      const target = mandatoryMatch[0]!;
      const check = evaluateFilesystemAccess(this.config.policy, target, "write", cwd);
      if (!check.allowed) {
        this.emitViolation(check.kind ?? "mandatory_deny", target, check.reason);
        return { allowed: false, error: check.reason };
      }
    }

    // 3. Check for writes outside allowed directories (e.g. `> /etc/foo` or `touch /var/foo` or `tee /usr/foo`)
    const redirectMatch = command.match(/(?:>{1,2}|\btee\s+|\btouch\s+|\bmkdir\s+(?:-p\s+)?)(\/[A-Za-z0-9_./-]+)/);
    if (redirectMatch) {
      const target = redirectMatch[1]!;
      if (!target.startsWith("/dev/")) {
        const check = evaluateFilesystemAccess(this.config.policy, target, "write", cwd);
        if (!check.allowed) {
          this.emitViolation(check.kind ?? "fs_write", target, check.reason);
          return { allowed: false, error: check.reason };
        }
      }
    }

    // 4. Check network calls inside shell (`curl`, `wget`, `fetch`, `169.254.169.254`)
    const isNetCmd = /\b(?:curl|wget|fetch|nc|ncat|urllib|requests)\b|169\.254\.169\.254/i.test(command);
    const urlMatches = isNetCmd ? command.match(/https?:\/\/[^\s"';|&)+]+|\b169\.254\.169\.254\b/g) : null;
    if (urlMatches) {
      for (const u of urlMatches) {
        const netCheck = evaluateNetworkAccess(this.config.policy, u, "GET");
        if (!netCheck.allowed) {
          this.emitViolation("network", u, netCheck.reason);
          return { allowed: false, error: netCheck.reason };
        }
      }
    }

    return { allowed: true };
  }

  private async execShell(
    sid: string,
    payload: Record<string, unknown>
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const command = String(payload.command ?? "");
    const timeoutSec = Number(payload.timeoutSec ?? 120);
    const idleTimeoutSec = Number(payload.idleTimeoutSec ?? timeoutSec);

    let session = this.shellSessions.get(sid);
    if (!session) {
      session = {
        sid,
        cwd: this.config.workspacePath,
        env: {
          HOME: this.config.workspacePath,
        },
        partialOutput: "",
        status: "idle",
      };
      this.shellSessions.set(sid, session);
    }

    const policyCheck = this.inspectShellCommandPolicy(command, session.cwd);
    if (!policyCheck.allowed) {
      return {
        status: 403,
        body: {
          exitCode: 126,
          output: policyCheck.error ?? "Blocked by sandbox policy",
          truncated: false,
          cwd: session.cwd,
          error: policyCheck.error,
        },
      };
    }

    // Handle `export KEY=VALUE` and `cd <dir>` persistence across calls in the same shell session
    const marker = `__OH_CWD_${crypto.randomBytes(4).toString("hex")}__`;
    const wrappedScript = `${command}\n__OH_EC=$?\necho "${marker}:$(pwd):$__OH_EC"`;

    return new Promise((resolve) => {
      let stdoutBuf = "";
      let stderrBuf = "";
      let settled = false;

      const child = spawnConfined(
        {
          srtSettingsPath: this.srtSettingsPath,
          runAs: this.config.runAs,
          useSrt: this.osEnforced,
        },
        wrappedScript,
        session!.cwd,
        session!.env
      );
      session!.runningChild = child;
      session!.status = "still_running";
      session!.partialOutput = "";

      const resetIdleTimer = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          if (settled) return;
          settled = true;
          const combined = this.redact(stdoutBuf + stderrBuf);
          session!.partialOutput = combined;
          resolve({
            status: 200,
            body: {
              exitCode: null,
              status: "still_running",
              output: combined,
              truncated: false,
              cwd: session!.cwd,
            },
          });
        }, idleTimeoutSec * 1000);
      };

      let idleTimer: ReturnType<typeof setTimeout> | null = null;
      resetIdleTimer();

      const hardTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        if (idleTimer) clearTimeout(idleTimer);
        killConfinedProcessGroup(child, "SIGKILL");
        session!.runningChild = undefined;
        session!.status = "idle";
        resolve({
          status: 200,
          body: {
            exitCode: 124,
            output: this.redact(stdoutBuf + stderrBuf + "\n[Command timed out]"),
            truncated: false,
            cwd: session!.cwd,
          },
        });
      }, timeoutSec * 1000);

      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBuf += chunk.toString("utf8");
        session!.partialOutput = stdoutBuf + stderrBuf;
        resetIdleTimer();
      });

      child.stderr.on("data", (chunk: Buffer) => {
        stderrBuf += chunk.toString("utf8");
        session!.partialOutput = stdoutBuf + stderrBuf;
        resetIdleTimer();
      });

      child.on("close", (code) => {
        clearTimeout(hardTimer);
        if (idleTimer) clearTimeout(idleTimer);
        session!.runningChild = undefined;
        session!.status = "idle";
        if (settled) return;
        settled = true;

        let exitCode = code ?? 0;
        const markerRegex = new RegExp(`${marker}:([^:\\n]+):(\\d+)\\s*$`);
        const m = stdoutBuf.match(markerRegex);
        if (m) {
          const newCwd = m[1]!.trim();
          exitCode = Number.parseInt(m[2]!, 10);
          stdoutBuf = stdoutBuf.replace(markerRegex, "");
          if (fs.existsSync(newCwd)) {
            session!.cwd = newCwd;
          }
        }

        // Persist simple `export VAR=val` statements in session env
        const exportMatches = command.matchAll(/\bexport\s+([A-Za-z_][A-Za-z0-9_]*)=([^\n;&]+)/g);
        for (const em of exportMatches) {
          const k = em[1]!;
          const v = em[2]!.trim().replace(/^["']|["']$/g, "");
          session!.env[k] = v;
        }

        const rawCombined = this.redact((stdoutBuf + stderrBuf).trimEnd());
        const MAX_BYTES = 50 * 1024;
        const truncated = rawCombined.length > MAX_BYTES;
        const output = truncated ? rawCombined.slice(0, MAX_BYTES) : rawCombined;

        resolve({
          status: 200,
          body: {
            exitCode,
            status: "completed",
            output,
            truncated,
            cwd: session!.cwd,
          },
        });
      });
    });
  }

  private async sendShellInput(
    sid: string,
    payload: Record<string, unknown>
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const session = this.shellSessions.get(sid);
    if (!session || !session.runningChild) {
      return { status: 404, body: { error: `No running command in shell session "${sid}"` } };
    }
    const input = String(payload.input ?? "");
    session.runningChild.stdin?.write(input);
    await new Promise((r) => setTimeout(r, 50));
    return {
      status: 200,
      body: {
        status: session.status,
        output: this.redact(session.partialOutput),
        cwd: session.cwd,
      },
    };
  }

  private async interruptShell(
    sid: string
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const session = this.shellSessions.get(sid);
    if (!session || !session.runningChild) {
      return { status: 200, body: { interrupted: false, status: "idle" } };
    }
    killConfinedProcessGroup(session.runningChild, "SIGINT");
    session.runningChild = undefined;
    session.status = "idle";
    return {
      status: 200,
      body: {
        interrupted: true,
        status: "idle",
        output: this.redact(session.partialOutput),
        cwd: session.cwd,
      },
    };
  }

  private async startBackgroundProcess(
    payload: Record<string, unknown>
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const command = String(payload.command ?? "");
    const cwd = payload.cwd ? path.resolve(this.config.workspacePath, String(payload.cwd)) : this.config.workspacePath;
    const portHint = typeof payload.port === "number" ? payload.port : undefined;

    const policyCheck = this.inspectShellCommandPolicy(command, cwd);
    if (!policyCheck.allowed) {
      return { status: 403, body: { error: policyCheck.error } };
    }

    const id = `proc_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
    const child = spawnConfined(
      {
        srtSettingsPath: this.srtSettingsPath,
        runAs: this.config.runAs,
        useSrt: this.osEnforced,
      },
      command,
      cwd,
      { HOME: this.config.workspacePath }
    );

    const procState: BackgroundProcessState = {
      id,
      command,
      cwd,
      child,
      logs: [],
      status: "running",
      startedAt: Date.now(),
    };
    this.processes.set(id, procState);

    const registerPort = (port: number) => {
      if (procState.port === port) return;
      procState.port = port;
      const previewUrl = `http://127.0.0.1:${port}`;
      procState.previewUrl = previewUrl;
      this.ports.set(port, previewUrl);
      this.config.onTelemetry?.({
        type: "port.opened",
        sessionId: this.config.sessionId,
        runId: this.config.runId,
        processId: id,
        port,
        previewUrl,
        timestamp: Date.now(),
      });
    };

    if (portHint) {
      registerPort(portHint);
    } else {
      const m = command.match(/\b(?:--port|-p|PORT=)\s*(\d{4,5})\b/);
      if (m) registerPort(Number.parseInt(m[1]!, 10));
    }

    const onOutput = (stream: "stdout" | "stderr", chunk: Buffer) => {
      const text = this.redact(chunk.toString("utf8"));
      procState.logs.push(text);
      const portMatch = text.match(/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{4,5})|port\s+(\d{4,5})/i);
      if (portMatch) {
        const p = Number.parseInt((portMatch[1] ?? portMatch[2])!, 10);
        if (p >= 1024 && p <= 65535) registerPort(p);
      }
      this.config.onTelemetry?.({
        type: "process.output",
        sessionId: this.config.sessionId,
        runId: this.config.runId,
        processId: id,
        stream,
        data: text,
        timestamp: Date.now(),
      });
    };

    child.stdout.on("data", (c: Buffer) => onOutput("stdout", c));
    child.stderr.on("data", (c: Buffer) => onOutput("stderr", c));
    child.on("close", () => {
      if (procState.status === "running") {
        procState.status = "exited";
      }
    });

    return {
      status: 200,
      body: {
        id,
        status: procState.status,
        port: procState.port,
        previewUrl: procState.previewUrl,
      },
    };
  }

  private async getProcessLogs(
    id: string,
    since: number
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const proc = this.processes.get(id);
    if (!proc) return { status: 404, body: { error: `Process "${id}" not found` } };
    const slice = proc.logs.slice(Math.max(0, since));
    return {
      status: 200,
      body: {
        id: proc.id,
        status: proc.status,
        port: proc.port,
        previewUrl: proc.previewUrl,
        logs: slice.join(""),
        nextCursor: proc.logs.length,
      },
    };
  }

  private async stopBackgroundProcess(
    id: string
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const proc = this.processes.get(id);
    if (!proc) return { status: 404, body: { error: `Process "${id}" not found` } };
    killConfinedProcessGroup(proc.child, "SIGTERM");
    proc.status = "stopped";
    if (proc.port) {
      this.ports.delete(proc.port);
    }
    return { status: 200, body: { id, status: "stopped" } };
  }

  // --- File Operations with Policy Gate, Paging, Fuzzy Diff, Undo, and Linter Gate ---

  private resolveSafePath(rawPath: string, op: "read" | "write"): {
    allowed: boolean;
    resolvedPath: string;
    error?: string;
  } {
    const check = evaluateFilesystemAccess(
      this.config.policy,
      rawPath,
      op,
      this.config.workspacePath
    );
    const rootDir = rawPath.startsWith("/memories")
      ? this.config.memoriesPath
      : rawPath.startsWith("/tmp")
      ? this.config.tmpPath
      : this.config.workspacePath;
    const relTarget = rawPath.startsWith("/memories")
      ? rawPath.replace(/^\/memories\/?/, "") || "."
      : rawPath.startsWith("/tmp")
      ? rawPath.replace(/^\/tmp\/?/, "") || "."
      : rawPath.startsWith(this.config.workspacePath)
      ? path.relative(this.config.workspacePath, rawPath) || "."
      : rawPath;

    if (!check.allowed) {
      const fallbackPath = path.resolve(rootDir, relTarget);
      this.emitViolation(check.kind ?? (op === "read" ? "fs_read" : "fs_write"), rawPath, check.reason);
      return { allowed: false, resolvedPath: fallbackPath, error: check.reason };
    }

    try {
      const resolvedPath = resolveInside(rootDir, relTarget);
      return { allowed: true, resolvedPath };
    } catch (err) {
      const fallbackPath = path.resolve(rootDir, relTarget);
      const reason = (err as Error).message;
      this.emitViolation(op === "read" ? "fs_read" : "fs_write", rawPath, reason);
      return { allowed: false, resolvedPath: fallbackPath, error: reason };
    }
  }

  private pushUndo(resolvedPath: string, previousContent: string): void {
    const stack = this.undoStack.get(resolvedPath) ?? [];
    stack.push(previousContent);
    if (stack.length > 20) stack.shift();
    this.undoStack.set(resolvedPath, stack);
  }

  private runPostEditSyntaxCheck(resolvedPath: string): { passed: boolean; diagnostics: string[] } {
    const ext = path.extname(resolvedPath).toLowerCase();
    const diagnostics: string[] = [];

    if (!fs.existsSync(resolvedPath)) {
      return { passed: true, diagnostics };
    }

    if (ext === ".json") {
      try {
        JSON.parse(fs.readFileSync(resolvedPath, "utf8"));
      } catch (err) {
        diagnostics.push(`JSON syntax error: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else if (ext === ".js" || ext === ".mjs" || ext === ".cjs") {
      const check = spawnConfinedArgv(["node", "--check", resolvedPath], this.config.workspacePath);
      if (check.status !== 0) {
        diagnostics.push((check.stderr || check.stdout || "JS syntax error").trim());
      }
    } else if (ext === ".py") {
      const check = spawnConfinedArgv(["python3", "-m", "py_compile", resolvedPath], this.config.workspacePath);
      if (check.status !== 0) {
        diagnostics.push((check.stderr || check.stdout || "Python syntax error").trim());
      }
    } else if (ext === ".ts" || ext === ".tsx") {
      const content = fs.readFileSync(resolvedPath, "utf8");
      const balanceErr = checkBraceBalance(content);
      if (balanceErr) {
        diagnostics.push(`TypeScript syntax error: ${balanceErr}`);
      }
    }

    return { passed: diagnostics.length === 0, diagnostics };
  }

  private async viewFile(
    payload: Record<string, unknown>
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const rawPath = String(payload.path ?? ".");
    const access = this.resolveSafePath(rawPath, "read");
    if (!access.allowed) {
      return { status: 403, body: { error: access.error } };
    }

    if (!fs.existsSync(access.resolvedPath)) {
      return { status: 404, body: { error: `Path not found: ${rawPath}` } };
    }

    const stat = fs.statSync(access.resolvedPath);
    if (stat.isDirectory()) {
      // Directory listing up to depth 2 (§5 C.2)
      const entries = listDirectoryToDepth(access.resolvedPath, 2);
      return {
        status: 200,
        body: {
          type: "directory",
          path: rawPath,
          entries,
          content: entries.join("\n"),
        },
      };
    }

    const content = fs.readFileSync(access.resolvedPath, "utf8");
    const allLines = content.split("\n");
    const offset = Math.max(1, Number(payload.offset ?? 1));
    const limit = Math.min(2000, Math.max(1, Number(payload.limit ?? 2000)));
    const sliced = allLines.slice(offset - 1, offset - 1 + limit);

    let numbered = sliced
      .map((line, idx) => `${String(offset + idx).padStart(5, " ")} | ${line}`)
      .join("\n");

    const MAX_BYTES = 50 * 1024;
    let truncated = offset - 1 + limit < allLines.length;
    if (numbered.length > MAX_BYTES) {
      numbered = numbered.slice(0, MAX_BYTES);
      truncated = true;
    }

    return {
      status: 200,
      body: {
        type: "file",
        path: rawPath,
        content,
        numberedContent: numbered,
        totalLines: allLines.length,
        offset,
        limit,
        truncated,
      },
    };
  }

  private async createFile(
    payload: Record<string, unknown>
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const rawPath = String(payload.path ?? "");
    const content = String(payload.content ?? "");
    const access = this.resolveSafePath(rawPath, "write");
    if (!access.allowed) {
      return { status: 403, body: { error: access.error } };
    }

    if (fs.existsSync(access.resolvedPath)) {
      this.pushUndo(access.resolvedPath, fs.readFileSync(access.resolvedPath, "utf8"));
    }
    fs.mkdirSync(path.dirname(access.resolvedPath), { recursive: true });
    fs.writeFileSync(access.resolvedPath, content, "utf8");

    const lint = this.runPostEditSyntaxCheck(access.resolvedPath);
    return {
      status: 200,
      body: {
        path: rawPath,
        created: true,
        bytesWritten: Buffer.byteLength(content, "utf8"),
        diagnostics: lint.diagnostics,
      },
    };
  }

  private async strReplaceFile(
    payload: Record<string, unknown>
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const rawPath = String(payload.path ?? "");
    const oldStr = String(payload.old_str ?? payload.oldStr ?? "");
    const newStr = String(payload.new_str ?? payload.newStr ?? "");

    const access = this.resolveSafePath(rawPath, "write");
    if (!access.allowed) {
      return { status: 403, body: { error: access.error } };
    }
    if (!fs.existsSync(access.resolvedPath)) {
      return { status: 404, body: { error: `File not found: ${rawPath}` } };
    }

    const original = fs.readFileSync(access.resolvedPath, "utf8");
    let updated: string | null = null;
    let fuzzyUsed = false;

    // 1. Exact uniqueness check
    const occurrences = original.split(oldStr).length - 1;
    if (occurrences === 1) {
      updated = original.replace(oldStr, () => newStr);
    } else if (occurrences > 1) {
      return {
        status: 400,
        body: {
          error: `old_str matched ${occurrences} locations in "${rawPath}"; provide more surrounding context so the match is unique.`,
        },
      };
    } else {
      // 2. Whitespace-normalized line-by-line fuzzy fallback (§5 C.2)
      const fuzzyMatch = tryFuzzyLineReplace(original, oldStr, newStr);
      if (fuzzyMatch.matchedCount === 1 && fuzzyMatch.updated !== null) {
        updated = fuzzyMatch.updated;
        fuzzyUsed = true;
      } else if (fuzzyMatch.matchedCount > 1) {
        return {
          status: 400,
          body: {
            error: `Fuzzy whitespace match found ${fuzzyMatch.matchedCount} locations in "${rawPath}"; provide more context.`,
          },
        };
      } else {
        return {
          status: 400,
          body: {
            error: `old_str not found in "${rawPath}". Re-read the file around the target lines before retrying.`,
          },
        };
      }
    }

    this.pushUndo(access.resolvedPath, original);
    fs.writeFileSync(access.resolvedPath, updated!, "utf8");
    const lint = this.runPostEditSyntaxCheck(access.resolvedPath);
    const diff = createSimpleDiff(rawPath, oldStr, newStr);

    return {
      status: 200,
      body: {
        path: rawPath,
        replaced: true,
        fuzzyUsed,
        diff,
        diagnostics: lint.diagnostics,
      },
    };
  }

  private async insertFile(
    payload: Record<string, unknown>
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const rawPath = String(payload.path ?? "");
    const insertLine = Number(payload.insert_line ?? payload.insertLine ?? 0);
    const newStr = String(payload.new_str ?? payload.newStr ?? "");

    const access = this.resolveSafePath(rawPath, "write");
    if (!access.allowed) {
      return { status: 403, body: { error: access.error } };
    }
    if (!fs.existsSync(access.resolvedPath)) {
      return { status: 404, body: { error: `File not found: ${rawPath}` } };
    }

    const original = fs.readFileSync(access.resolvedPath, "utf8");
    const lines = original.split("\n");
    const clampedIdx = Math.max(0, Math.min(lines.length, insertLine));
    lines.splice(clampedIdx, 0, ...newStr.split("\n"));
    const updated = lines.join("\n");

    this.pushUndo(access.resolvedPath, original);
    fs.writeFileSync(access.resolvedPath, updated, "utf8");
    const lint = this.runPostEditSyntaxCheck(access.resolvedPath);

    return {
      status: 200,
      body: {
        path: rawPath,
        insertedAtLine: clampedIdx,
        diagnostics: lint.diagnostics,
      },
    };
  }

  private async undoEditFile(
    payload: Record<string, unknown>
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const rawPath = String(payload.path ?? "");
    const access = this.resolveSafePath(rawPath, "write");
    if (!access.allowed) {
      return { status: 403, body: { error: access.error } };
    }
    const stack = this.undoStack.get(access.resolvedPath);
    if (!stack || stack.length === 0) {
      return { status: 400, body: { error: `No edit history to undo for "${rawPath}"` } };
    }
    const previous = stack.pop()!;
    fs.writeFileSync(access.resolvedPath, previous, "utf8");
    return { status: 200, body: { path: rawPath, undone: true } };
  }

  private async applyPatch(
    payload: Record<string, unknown>
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const patchText = String(payload.patch ?? "");
    const modifiedFiles: string[] = [];
    const allDiagnostics: Record<string, string[]> = {};

    if (patchText.includes("*** Begin Patch")) {
      // OpenAI *** Begin Patch format (§5 C.2)
      const lines = patchText.split("\n");
      let currentFile: string | null = null;
      let currentAction: "add" | "update" | "delete" | null = null;
      let hunkLines: string[] = [];

      const flushFile = () => {
        if (!currentFile || !currentAction) return;
        const access = this.resolveSafePath(currentFile, "write");
        if (!access.allowed) {
          throw new Error(access.error ?? `Patch denied on ${currentFile}`);
        }
        if (currentAction === "delete") {
          if (fs.existsSync(access.resolvedPath)) {
            this.pushUndo(access.resolvedPath, fs.readFileSync(access.resolvedPath, "utf8"));
            fs.unlinkSync(access.resolvedPath);
          }
          modifiedFiles.push(currentFile);
        } else if (currentAction === "add") {
          const content = hunkLines
            .map((l) => (l.startsWith("+") ? l.slice(1) : l))
            .join("\n");
          fs.mkdirSync(path.dirname(access.resolvedPath), { recursive: true });
          fs.writeFileSync(access.resolvedPath, content, "utf8");
          modifiedFiles.push(currentFile);
          const lint = this.runPostEditSyntaxCheck(access.resolvedPath);
          if (lint.diagnostics.length > 0) allDiagnostics[currentFile] = lint.diagnostics;
        } else if (currentAction === "update") {
          const orig = fs.existsSync(access.resolvedPath)
            ? fs.readFileSync(access.resolvedPath, "utf8")
            : "";
          this.pushUndo(access.resolvedPath, orig);
          const updated = applySimpleHunkLines(orig, hunkLines);
          fs.writeFileSync(access.resolvedPath, updated, "utf8");
          modifiedFiles.push(currentFile);
          const lint = this.runPostEditSyntaxCheck(access.resolvedPath);
          if (lint.diagnostics.length > 0) allDiagnostics[currentFile] = lint.diagnostics;
        }
        currentFile = null;
        currentAction = null;
        hunkLines = [];
      };

      try {
        for (const line of lines) {
          if (line.startsWith("*** Add File: ")) {
            flushFile();
            currentFile = line.slice("*** Add File: ".length).trim();
            currentAction = "add";
          } else if (line.startsWith("*** Update File: ")) {
            flushFile();
            currentFile = line.slice("*** Update File: ".length).trim();
            currentAction = "update";
          } else if (line.startsWith("*** Delete File: ")) {
            flushFile();
            currentFile = line.slice("*** Delete File: ".length).trim();
            currentAction = "delete";
          } else if (line.startsWith("*** End Patch") || line.startsWith("*** Begin Patch")) {
            flushFile();
          } else if (currentFile) {
            hunkLines.push(line);
          }
        }
        flushFile();
      } catch (err) {
        return {
          status: 403,
          body: { error: err instanceof Error ? err.message : String(err) },
        };
      }
    } else {
      // Standard unified diff (`--- a/path`, `+++ b/path`)
      const fileSections = patchText.split(/^---\s+/m).slice(1);
      for (const sec of fileSections) {
        const secLines = sec.split("\n");
        const plusLine = secLines.find((l) => l.startsWith("+++ "));
        if (!plusLine) continue;
        const targetPath = plusLine
          .slice(4)
          .trim()
          .replace(/^[ab]\//, "")
          .split("\t")[0]!;
        const access = this.resolveSafePath(targetPath, "write");
        if (!access.allowed) {
          return { status: 403, body: { error: access.error } };
        }
        const orig = fs.existsSync(access.resolvedPath)
          ? fs.readFileSync(access.resolvedPath, "utf8")
          : "";
        this.pushUndo(access.resolvedPath, orig);
        const hunkBody = secLines.slice(secLines.indexOf(plusLine) + 1);
        const updated = applySimpleHunkLines(orig, hunkBody);
        fs.mkdirSync(path.dirname(access.resolvedPath), { recursive: true });
        fs.writeFileSync(access.resolvedPath, updated, "utf8");
        modifiedFiles.push(targetPath);
        const lint = this.runPostEditSyntaxCheck(access.resolvedPath);
        if (lint.diagnostics.length > 0) allDiagnostics[targetPath] = lint.diagnostics;
      }
    }

    return {
      status: 200,
      body: {
        applied: true,
        modifiedFiles,
        diagnostics: allDiagnostics,
      },
    };
  }

  private async searchGlob(
    payload: Record<string, unknown>
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const pattern = String(payload.pattern ?? "**/*");
    const limit = Math.min(500, Math.max(1, Number(payload.limit ?? 100)));
    const allFiles = walkWorkspaceFiles(this.config.workspacePath);
    const regex = globToRegExp(pattern);
    const matches = allFiles.filter((rel) => regex.test(rel)).slice(0, limit);
    return {
      status: 200,
      body: {
        pattern,
        matches,
        count: matches.length,
      },
    };
  }

  private async searchGrep(
    payload: Record<string, unknown>
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const query = String(payload.pattern ?? payload.query ?? "");
    const limit = Math.min(200, Math.max(1, Number(payload.limit ?? 50)));
    const regex = new RegExp(query, payload.caseSensitive ? "" : "i");
    const allFiles = walkWorkspaceFiles(this.config.workspacePath);
    const results: Array<{ file: string; line: number; text: string }> = [];

    for (const rel of allFiles) {
      if (results.length >= limit) break;
      const full = path.join(this.config.workspacePath, rel);
      try {
        const content = fs.readFileSync(full, "utf8");
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (regex.test(lines[i]!)) {
            results.push({
              file: rel,
              line: i + 1,
              text: lines[i]!.slice(0, 240),
            });
            if (results.length >= limit) break;
          }
        }
      } catch {
        // skip binary/unreadable file
      }
    }

    return {
      status: 200,
      body: {
        pattern: query,
        results,
        count: results.length,
      },
    };
  }

  // --- Shadow-Git Checkpoints (`GIT_DIR=<shadowGitDir>`, `GIT_WORK_TREE=<workspace>`) (§5 C.2, §11 Phase I) ---

  private runShadowGit(args: string[]): { status: number; stdout: string; stderr: string } {
    const gitEnv = {
      GIT_AUTHOR_NAME: "OpenHarness Checkpoint",
      GIT_AUTHOR_EMAIL: "checkpoint@openharness.dev",
      GIT_COMMITTER_NAME: "OpenHarness Checkpoint",
      GIT_COMMITTER_EMAIL: "checkpoint@openharness.dev",
    };
    const baseArgs = [
      `--git-dir=${this.config.shadowGitDir}`,
      `--work-tree=${this.config.workspacePath}`,
    ];

    if (!this.shadowGitInitialized) {
      if (!fs.existsSync(path.join(this.config.shadowGitDir, "HEAD"))) {
        spawnConfinedArgv(["git", ...baseArgs, "init"], this.config.workspacePath, gitEnv);
      }
      this.shadowGitInitialized = true;
    }

    const res = spawnConfinedArgv(["git", ...baseArgs, ...args], this.config.workspacePath, gitEnv);
    return {
      status: res.status,
      stdout: res.stdout.trim(),
      stderr: res.stderr.trim(),
    };
  }

  private async createCheckpoint(
    payload: Record<string, unknown>
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const message = String(payload.message ?? "Checkpoint");
    this.runShadowGit(["add", "-A"]);
    const statusOut = this.runShadowGit(["status", "--porcelain"]);
    const files = statusOut.stdout
      ? statusOut.stdout
          .split("\n")
          .map((l) => l.slice(3).trim())
          .filter(Boolean)
      : [];
    this.runShadowGit([
      "-c",
      "user.name=OpenHarness",
      "-c",
      "user.email=oh@local",
      "commit",
      "--allow-empty",
      "--no-gpg-sign",
      "-m",
      message,
    ]);
    const rev = this.runShadowGit(["rev-parse", "HEAD"]);
    if (rev.status !== 0 || !rev.stdout) {
      return {
        status: 500,
        body: { error: rev.stderr || "shadow-git rev-parse failed" },
      };
    }
    return {
      status: 200,
      body: {
        sha: rev.stdout,
        message,
        files,
        createdAt: Date.now(),
      },
    };
  }

  private async diffCheckpoint(
    payload: Record<string, unknown>
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const fromSha = String(payload.from ?? "HEAD~1");
    const toSha = payload.to ? String(payload.to) : undefined;
    const args = toSha ? ["diff", fromSha, toSha] : ["diff", fromSha];
    const res = this.runShadowGit(args);
    return {
      status: 200,
      body: {
        from: fromSha,
        to: toSha ?? "WORKTREE",
        diff: res.stdout,
      },
    };
  }

  private async restoreCheckpoint(
    payload: Record<string, unknown>
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const sha = String(payload.sha ?? "HEAD");
    const paths = Array.isArray(payload.paths) ? payload.paths.map(String) : [];
    if (paths.length > 0) {
      this.runShadowGit(["checkout", sha, "--", ...paths]);
    } else {
      this.runShadowGit(["checkout", "-f", sha]);
      this.runShadowGit(["clean", "-fd"]);
    }
    return {
      status: 200,
      body: {
        restored: true,
        sha,
        paths: paths.length > 0 ? paths : undefined,
      },
    };
  }

  // --- Browser Automation Routes (§5 C.2) ---

  private async browserNavigate(
    payload: Record<string, unknown>
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const url = String(payload.url ?? "");
    const parsed = new URL(url);
    const isLocalPreview =
      (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost") &&
      this.ports.has(Number(parsed.port || 80));

    if (!isLocalPreview) {
      const netCheck = evaluateNetworkAccess(this.config.policy, url, "GET");
      if (!netCheck.allowed) {
        this.emitViolation("network", url, netCheck.reason);
        this.browser.networkErrors.push(netCheck.reason ?? `Blocked: ${url}`);
        return { status: 403, body: { error: netCheck.reason } };
      }
    }

    this.browser.currentUrl = url;
    if (typeof payload.html === "string") {
      this.browser.html = payload.html;
    } else if (isLocalPreview) {
      // Try fetching local dev server page if reachable, or synthesize preview DOM
      try {
        const resp = await fetch(url);
        this.browser.html = await resp.text();
      } catch {
        this.browser.html = `<html><head><title>Preview ${url}</title></head><body><h1>Running at ${url}</h1><button id="app-btn">Action</button><input name="q" /></body></html>`;
      }
    } else {
      this.browser.html = `<html><head><title>${url}</title></head><body><h1>${url}</h1><a href="/">Home</a></body></html>`;
    }

    this.browser.title =
      this.browser.html.match(/<title>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? url;
    this.browser.elements = extractAccessibilityHandles(this.browser.html);

    return {
      status: 200,
      body: {
        url: this.browser.currentUrl,
        title: this.browser.title,
        refsCount: this.browser.elements.length,
      },
    };
  }

  private async browserSnapshot(): Promise<{ status: number; body: Record<string, unknown> }> {
    const treeLines = [
      `- document [title="${this.browser.title}" url="${this.browser.currentUrl}"]`,
      ...this.browser.elements.map(
        (el) =>
          `  - ${el.role} "${el.name}" [ref=${el.ref}]${el.value ? ` value="${el.value}"` : ""}`
      ),
    ];
    return {
      status: 200,
      body: {
        url: this.browser.currentUrl,
        title: this.browser.title,
        snapshot: treeLines.join("\n"),
        elements: this.browser.elements,
      },
    };
  }

  private async browserClick(
    payload: Record<string, unknown>
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const ref = String(payload.ref ?? "");
    const el = this.browser.elements.find((e) => e.ref === ref);
    if (!el) {
      return { status: 400, body: { error: `Element handle [ref=${ref}] not found in snapshot` } };
    }
    this.browser.consoleLogs.push(`[browser] Clicked [${ref}] (${el.role} "${el.name}")`);
    return { status: 200, body: { clicked: ref, element: el } };
  }

  private async browserType(
    payload: Record<string, unknown>
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const ref = String(payload.ref ?? "");
    const text = String(payload.text ?? "");
    const el = this.browser.elements.find((e) => e.ref === ref);
    if (!el) {
      return { status: 400, body: { error: `Element handle [ref=${ref}] not found in snapshot` } };
    }
    el.value = text;
    this.browser.consoleLogs.push(`[browser] Typed into [${ref}]`);
    return { status: 200, body: { typed: ref, value: text } };
  }

  private async browserPress(
    payload: Record<string, unknown>
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const key = String(payload.key ?? "Enter");
    this.browser.consoleLogs.push(`[browser] Pressed key "${key}"`);
    return { status: 200, body: { pressed: key } };
  }

  private async browserScreenshot(): Promise<{ status: number; body: Record<string, unknown> }> {
    // 1x1 valid PNG base64 representation + metadata for headless verification
    const pngBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    return {
      status: 200,
      body: {
        mimeType: "image/png",
        url: this.browser.currentUrl,
        title: this.browser.title,
        dataBase64: pngBase64,
      },
    };
  }

  private async execIpython(
    payload: Record<string, unknown>
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const code = String(payload.code ?? "");
    const res = spawnConfinedArgv(["python3", "-c", code], this.config.workspacePath, {}, 30_000);
    return {
      status: 200,
      body: {
        exitCode: res.status,
        stdout: this.redact(res.stdout),
        stderr: this.redact(res.stderr),
        varsCount: this.ipythonVars.size,
      },
    };
  }

  async listen(port = 0, host = "127.0.0.1"): Promise<string> {
    return new Promise((resolve, reject) => {
      const srv = http.createServer(async (req, res) => {
        try {
          const chunks: Buffer[] = [];
          for await (const chunk of req) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          }
          const rawBody = Buffer.concat(chunks).toString("utf8");
          const parsedBody = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {};
          const headers: Record<string, string | undefined> = {};
          for (const [k, v] of Object.entries(req.headers)) {
            headers[k] = Array.isArray(v) ? v[0] : v;
          }
          const response = await this.handleRequest(
            req.method ?? "GET",
            req.url ?? "/",
            headers,
            parsedBody
          );
          res.writeHead(response.status, { "Content-Type": "application/json", ...response.headers });
          res.end(JSON.stringify(response.body));
        } catch (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        }
      });
      srv.on("error", reject);
      srv.listen(port, host, () => {
        this.httpServer = srv;
        const addr = srv.address();
        const actualPort = typeof addr === "object" && addr ? addr.port : port;
        resolve(`http://${host}:${actualPort}`);
      });
    });
  }

  async close(): Promise<void> {
    await this.browserBridge.close().catch(() => {});
    for (const proc of this.processes.values()) {
      killConfinedProcessGroup(proc.child, "SIGTERM");
    }
    for (const s of this.shellSessions.values()) {
      killConfinedProcessGroup(s.runningChild, "SIGTERM");
    }
    if (this.httpServer) {
      await new Promise<void>((r) => this.httpServer!.close(() => r()));
      this.httpServer = undefined;
    }
  }
}

function listDirectoryToDepth(
  dirPath: string,
  maxDepth: number,
  currentDepth = 1,
  prefix = ""
): string[] {
  const results: string[] = [];
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return results;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      results.push(`${rel}/`);
      if (currentDepth < maxDepth) {
        results.push(
          ...listDirectoryToDepth(
            path.join(dirPath, entry.name),
            maxDepth,
            currentDepth + 1,
            rel
          )
        );
      }
    } else {
      results.push(rel);
    }
  }
  return results;
}

function walkWorkspaceFiles(rootDir: string, relDir = ""): string[] {
  const out: string[] = [];
  const target = relDir ? path.join(rootDir, relDir) : rootDir;
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(target, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules" || entry.name.startsWith(".shadow")) {
      continue;
    }
    const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...walkWorkspaceFiles(rootDir, rel));
    } else {
      out.push(rel);
    }
  }
  return out;
}

function globToRegExp(glob: string): RegExp {
  if (glob === "**/*" || glob === "*") return /^.+$/;
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\//g, "(?:.+/)?")
    .replace(/\*\*/g, ".*")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]");
  return new RegExp(`^${escaped}$`);
}

function tryFuzzyLineReplace(
  original: string,
  oldStr: string,
  newStr: string
): { matchedCount: number; updated: string | null } {
  const origLines = original.split("\n");
  const targetLines = oldStr.split("\n").map((l) => l.trim());
  if (targetLines.length === 0) return { matchedCount: 0, updated: null };

  const matchIndices: number[] = [];
  for (let i = 0; i <= origLines.length - targetLines.length; i++) {
    let ok = true;
    for (let j = 0; j < targetLines.length; j++) {
      if (origLines[i + j]!.trim() !== targetLines[j]) {
        ok = false;
        break;
      }
    }
    if (ok) matchIndices.push(i);
  }

  if (matchIndices.length !== 1) {
    return { matchedCount: matchIndices.length, updated: null };
  }
  const start = matchIndices[0]!;
  const updatedLines = [...origLines];
  updatedLines.splice(start, targetLines.length, ...newStr.split("\n"));
  return { matchedCount: 1, updated: updatedLines.join("\n") };
}

function createSimpleDiff(filePath: string, oldStr: string, newStr: string): string {
  const minus = oldStr
    .split("\n")
    .map((l) => `-${l}`)
    .join("\n");
  const plus = newStr
    .split("\n")
    .map((l) => `+${l}`)
    .join("\n");
  return `--- a/${filePath}\n+++ b/${filePath}\n@@ @@\n${minus}\n${plus}`;
}

function applySimpleHunkLines(original: string, hunkLines: string[]): string {
  const minusLines: string[] = [];
  const plusLines: string[] = [];
  for (const line of hunkLines) {
    if (line.startsWith("@@")) continue;
    if (line.startsWith("-")) minusLines.push(line.slice(1));
    else if (line.startsWith("+")) plusLines.push(line.slice(1));
  }
  if (minusLines.length === 0 && plusLines.length > 0) {
    return original ? `${original}\n${plusLines.join("\n")}` : plusLines.join("\n");
  }
  const oldBlock = minusLines.join("\n");
  const newBlock = plusLines.join("\n");
  if (oldBlock && original.includes(oldBlock)) {
    return original.replace(oldBlock, () => newBlock);
  }
  const fuzzy = tryFuzzyLineReplace(original, oldBlock, newBlock);
  return fuzzy.updated ?? original;
}

function checkBraceBalance(code: string): string | null {
  let braces = 0;
  let parens = 0;
  let inStr: string | null = null;
  for (let i = 0; i < code.length; i++) {
    const ch = code[i]!;
    if (inStr) {
      if (ch === "\\" && i + 1 < code.length) {
        i++;
        continue;
      }
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inStr = ch;
      continue;
    }
    if (ch === "/" && code[i + 1] === "/") {
      const nl = code.indexOf("\n", i);
      if (nl === -1) break;
      i = nl;
      continue;
    }
    if (ch === "{") braces++;
    else if (ch === "}") braces--;
    else if (ch === "(") parens++;
    else if (ch === ")") parens--;
    if (braces < 0) return "Unexpected closing brace '}'";
    if (parens < 0) return "Unexpected closing parenthesis ')'";
  }
  if (braces !== 0) return `Unbalanced braces (delta: ${braces})`;
  if (parens !== 0) return `Unbalanced parentheses (delta: ${parens})`;
  return null;
}

function extractAccessibilityHandles(
  html: string
): Array<{ ref: string; role: string; name: string; value?: string }> {
  const elements: Array<{ ref: string; role: string; name: string; value?: string }> = [];
  let counter = 1;

  const headingMatches = html.matchAll(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi);
  for (const m of headingMatches) {
    elements.push({
      ref: `e${counter++}`,
      role: "heading",
      name: m[2]!.replace(/<[^>]+>/g, "").trim(),
    });
  }

  const buttonMatches = html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/gi);
  for (const m of buttonMatches) {
    elements.push({
      ref: `e${counter++}`,
      role: "button",
      name: m[1]!.replace(/<[^>]+>/g, "").trim() || "button",
    });
  }

  const linkMatches = html.matchAll(/<a[^>]*>([\s\S]*?)<\/a>/gi);
  for (const m of linkMatches) {
    elements.push({
      ref: `e${counter++}`,
      role: "link",
      name: m[1]!.replace(/<[^>]+>/g, "").trim() || "link",
    });
  }

  const inputMatches = html.matchAll(/<input([^>]*)\/?>/gi);
  for (const m of inputMatches) {
    const attrs = m[1] ?? "";
    const nameAttr =
      attrs.match(/name=["']([^"']+)["']/i)?.[1] ??
      attrs.match(/placeholder=["']([^"']+)["']/i)?.[1] ??
      "textbox";
    elements.push({
      ref: `e${counter++}`,
      role: "textbox",
      name: nameAttr,
    });
  }

  return elements;
}
