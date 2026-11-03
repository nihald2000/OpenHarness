import crypto from "node:crypto";
import fs from "node:fs";
import http, { type IncomingMessage, type Server, type ServerResponse } from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { WebSocket, WebSocketServer } from "ws";
import { compileSandboxPolicy } from "../../core/src/sandbox/policy.ts";
import { verifyLiveTicket } from "../../core/src/sandbox/live-ticket.ts";
import { SandboxDaemon } from "./server.ts";

const SANDBOX_ID = /^[A-Za-z0-9_-]{3,96}$/;
const MAX_BODY_BYTES = 40 * 1024 * 1024;

function requireKey(value: string | undefined): string {
  const key = (value ?? "").trim();
  if (key.length < 32) throw new Error("OH_MODAL_SANDBOX_KEY (>= 32 chars) is required for the sandbox hub");
  return key;
}

const perSessionUid = process.platform === "linux" && process.getuid?.() === 0 && process.env.OH_HUB_PER_SESSION_UID !== "0";
type Owner = { uid: number; gid: number };

function sessionOwner(base: string, sandboxId: string): Owner {
  try {
    const st = fs.statSync(path.join(base, "workspace"));
    if (st.uid !== 0) return { uid: st.uid, gid: st.gid };
  } catch {}
  const root = path.dirname(base);
  const occupied = new Set<number>();
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || path.join(root, entry.name) === base) continue;
      try {
        const st = fs.statSync(path.join(root, entry.name, "workspace"));
        if (st.uid !== 0) occupied.add(st.uid);
      } catch {}
    }
  } catch {}
  const n = Number.parseInt(crypto.createHash("sha256").update(sandboxId).digest("hex").slice(0, 8), 16) % 40_000;
  for (let offset = 0; offset < 40_000; offset++) {
    const id = 20_000 + ((n + offset) % 40_000);
    if (!occupied.has(id)) return { uid: id, gid: id };
  }
  throw new Error("No free per-session uid is available");
}

function prepareSessionDirs(root: string, base: string, tmpPath: string, owner: Owner): void {
  fs.mkdirSync(root, { recursive: true });
  fs.chmodSync(root, 0o711);
  fs.mkdirSync("/tmp/oh", { recursive: true });
  fs.chmodSync("/tmp/oh", 0o711);
  fs.mkdirSync(base, { recursive: true, mode: 0o711 });
  fs.chmodSync(base, 0o711);
  for (const dir of [path.join(base, "workspace"), path.join(base, "home"), tmpPath]) {
    fs.mkdirSync(dir, { recursive: true });
    fs.chownSync(dir, owner.uid, owner.gid);
    fs.chmodSync(dir, 0o700);
  }
  for (const dir of [path.join(base, "memories"), path.join(base, ".shadow-git")]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
  }
  reclaimOwnership(path.join(base, "workspace"), owner);
}

function reclaimOwnership(workspacePath: string, owner: Owner): void {
  spawnSync("find", [workspacePath, "-xdev", "-user", "0", "-exec", "chown", "-h", `${owner.uid}:${owner.gid}`, "{}", "+"], {
    stdio: "ignore", timeout: 20_000,
  });
}

export interface SandboxHubOptions {
  host?: string;
  port?: number;
  root?: string;
  sessionKey?: string;
  liveAllowedOrigins?: string[];
}

export type SandboxHubServer = Server & {
  daemons: Map<string, SandboxDaemon>;
  closeHub(): Promise<void>;
};

function sendJson(res: ServerResponse, status: number, body: Record<string, unknown>, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...headers });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer | string) => {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += data.byteLength;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("request body is too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(data);
    });
    req.on("end", () => {
      if (!size) return resolve({});
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("JSON body must be an object");
        resolve(parsed as Record<string, unknown>);
      } catch (err) {
        reject(Object.assign(err instanceof Error ? err : new Error(String(err)), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

function safeEquals(expected: string, actual: string | undefined): boolean {
  if (!actual) return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(actual, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function proxyPreview(req: IncomingMessage, res: ServerResponse, port: number, targetPath: string): void {
  const upstream = http.request({
    hostname: "127.0.0.1",
    port,
    method: req.method,
    path: targetPath,
    headers: { ...req.headers, host: `127.0.0.1:${port}` },
  }, (upstreamRes) => {
    res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
    upstreamRes.pipe(res);
  });
  upstream.on("error", () => {
    if (res.headersSent) return res.destroy();
    const html = `<html><body><h1>Preview is starting</h1><p>Nothing is listening on port ${port} yet.</p></body></html>`;
    res.writeHead(502, { "content-type": "text/html; charset=utf-8", "content-length": Buffer.byteLength(html) });
    res.end(html);
  });
  req.pipe(upstream);
}

function previewTarget(url: string | undefined): { port: number; path: string } | undefined {
  if (!url) return undefined;
  const match = url.match(/^\/preview\/(\d{1,5})(\/[^?#]*)?(\?[^#]*)?$/);
  if (!match) return undefined;
  const port = Number(match[1]);
  if (port < 1024 || port > 65535 || port === 8080) return undefined;
  return { port, path: `${match[2] || "/"}${match[3] || ""}` };
}

function previewPortFromReferer(rawReferer: string | undefined): number | undefined {
  if (!rawReferer) return undefined;
  try {
    const parsed = new URL(rawReferer);
    const match = parsed.pathname.match(/^\/preview\/(\d{1,5})(?:\/|$)/);
    if (!match) return undefined;
    const port = Number(match[1]);
    return port >= 1024 && port <= 65535 && port !== 8080 ? port : undefined;
  } catch {
    return undefined;
  }
}

function isReservedDaemonPath(pathname: string): boolean {
  return /^\/(?:health|sessions(?:\/|$)|files(?:\/|$)|search(?:\/|$)|shell(?:\/|$)|exec(?:\/|$)|processes(?:\/|$)|checkpoints(?:\/|$)|workspace(?:\/|$)|ports(?:\/|$)|browser(?:\/|$)|ipython(?:\/|$)|preview(?:\/|$)|v1(?:\/|$))/.test(pathname);
}

export function createSandboxHubServer(options: SandboxHubOptions = {}): SandboxHubServer {
  if (process.env.OH_HUB_PER_SESSION_UID === "1" && !perSessionUid) {
    throw new Error("Per-session uid isolation requires a Linux root hub process");
  }
  const root = path.resolve(options.root ?? process.env.OH_WORKSPACES_ROOT ?? "/workspaces");
  const sessionKey = requireKey(options.sessionKey ?? process.env.OH_MODAL_SANDBOX_KEY ?? process.env.OH_SESSION_KEY);

  const daemons = new Map<string, SandboxDaemon>();
  const owners = new Map<string, Owner>();
  const browserOwners = new Map<string, "agent" | "human">();
  const livePeers = new Map<string, Set<WebSocket>>();
  const usedNonces = new Map<string, number>();
  const liveTicketKey = requireKey(options.sessionKey ?? process.env.OH_MODAL_SANDBOX_KEY ?? process.env.OH_SESSION_KEY);
  const liveAllowedOrigins = new Set(
    (options.liveAllowedOrigins ?? (process.env.OH_LIVE_ALLOWED_ORIGINS ?? "").split(","))
      .map((origin) => origin.trim())
      .filter(Boolean)
  );
  const webSocketServer = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
  const getOrCreateDaemon = (sandboxId: string): SandboxDaemon => {
    const existing = daemons.get(sandboxId);
    if (existing) return existing;
    const base = path.join(root, sandboxId);
    const workspacePath = path.join(base, "workspace");
    const tmpPath = path.join("/tmp/oh", sandboxId);
    const homePath = path.join(base, "home");
    const owner = perSessionUid ? sessionOwner(base, sandboxId) : undefined;
    if (owner) {
      prepareSessionDirs(root, base, tmpPath, owner);
      owners.set(sandboxId, owner);
    } else {
      fs.mkdirSync(workspacePath, { recursive: true, mode: 0o700 });
      fs.mkdirSync(homePath, { recursive: true, mode: 0o700 });
      fs.mkdirSync(tmpPath, { recursive: true, mode: 0o700 });
    }
    const runId = `hub_${sandboxId}`;
    const daemon = new SandboxDaemon({
      sessionId: sandboxId,
      runId,
      sessionKey,
      workspacePath,
      memoriesPath: path.join(base, "memories"),
      tmpPath,
      homePath,
      shadowGitDir: path.join(base, ".shadow-git"),
      runAs: owner,
      policy: compileSandboxPolicy({ runId, phase: "agent", workspacePath, networkMode: "open" }),
    });
    browserOwners.set(sandboxId, "agent");
    daemons.set(sandboxId, daemon);
    return daemon;
  };

  const server = http.createServer(async (req, res) => {
    const url = req.url ?? "/";
    const requestUrl = new URL(url, "http://127.0.0.1");
    if (req.method === "GET" && url === "/health") {
      return sendJson(res, 200, { ok: true, osEnforced: true, mode: "pinned-hub", activeSandboxes: daemons.size }, { "x-oh-daemon": "1" });
    }

    const barePreview = requestUrl.pathname.match(/^\/preview\/(\d{1,5})$/);
    if (req.method === "GET" && barePreview) {
      const port = Number(barePreview[1]);
      if (port < 1024 || port > 65535 || port === 8080) {
        return sendJson(res, 400, { error: "Invalid preview port" });
      }
      res.writeHead(302, { location: `/preview/${port}/${requestUrl.search}` });
      return res.end();
    }

    const hasValidSessionKey = (() => {
      const provided = req.headers["x-session-key"];
      return safeEquals(sessionKey, Array.isArray(provided) ? provided[0] : provided);
    })();
    const isAllowedPreviewPort = (port: number): boolean => {
      if (port < 1024 || port > 65535 || port === 8080 || port === 4096) return false;
      for (const d of daemons.values()) {
        if (d.isServicePort(port)) return false;
      }
      if (hasValidSessionKey) return true;
      for (const d of daemons.values()) {
        if (d.isRegisteredPreviewPort(port)) return true;
      }
      return daemons.size > 0;
    };

    const preview = previewTarget(url);
    if (preview) {
      if (!isAllowedPreviewPort(preview.port)) {
        return sendJson(res, 403, { error: "Forbidden: preview port is not registered to an active sandbox session" }, { "x-oh-daemon": "1" });
      }
      return proxyPreview(req, res, preview.port, preview.path);
    }
    if (url.startsWith("/preview/")) return sendJson(res, 400, { error: "Invalid preview port" });

    const refererPort = previewPortFromReferer(typeof req.headers.referer === "string" ? req.headers.referer : undefined);
    if (
      req.method === "GET" &&
      refererPort !== undefined &&
      !isReservedDaemonPath(requestUrl.pathname)
    ) {
      for (const d of daemons.values()) {
        if (d.isServicePort(refererPort)) {
          return sendJson(res, 403, { error: "Forbidden: internal service port cannot be proxied" }, { "x-oh-daemon": "1" });
        }
      }
      return proxyPreview(req, res, refererPort, `${requestUrl.pathname}${requestUrl.search}`);
    }

    const providedKey = req.headers["x-session-key"];
    if (!safeEquals(sessionKey, Array.isArray(providedKey) ? providedKey[0] : providedKey)) {
      return sendJson(res, 401, { error: "Unauthorized: invalid or missing X-Session-Key" }, { "x-oh-daemon": "1" });
    }
    const sandboxId = String(req.headers["x-oh-sandbox-id"] ?? "default");
    if (!SANDBOX_ID.test(sandboxId)) return sendJson(res, 400, { error: "Invalid sandbox ID" }, { "x-oh-daemon": "1" });

    let body: Record<string, unknown>;
    try {
      body = await readBody(req);
    } catch (err) {
      const status = Number((err as { status?: number }).status ?? 400);
      return sendJson(res, status, { error: (err as Error).message }, { "x-oh-daemon": "1" });
    }

    if (req.method === "POST" && new URL(url, "http://127.0.0.1").pathname === "/sessions/init") {
      const daemon = getOrCreateDaemon(sandboxId);
      return sendJson(res, 200, { ok: true, sandboxId, workspacePath: daemon.config.workspacePath }, { "x-oh-daemon": "1" });
    }
    if (req.method === "DELETE" && new URL(url, "http://127.0.0.1").pathname === "/sessions") {
      const daemon = daemons.get(sandboxId);
      if (daemon) {
        await daemon.handleRequest("POST", "/processes/stop-all", { "x-session-key": sessionKey });
        await daemon.close();
        daemons.delete(sandboxId);
        browserOwners.delete(sandboxId);
        for (const peer of livePeers.get(sandboxId) ?? []) peer.close(1001, "Sandbox closed");
        livePeers.delete(sandboxId);
      }
      return sendJson(res, 200, { ok: true }, { "x-oh-daemon": "1" });
    }

    const daemon = getOrCreateDaemon(sandboxId);
    const routePath = new URL(url, "http://127.0.0.1").pathname;
    if (req.method === "POST" && routePath === "/browser/lock") {
      const owner = body.owner;
      if (owner !== "agent" && owner !== "human") return sendJson(res, 400, { error: "owner must be agent or human" }, { "x-oh-daemon": "1" });
      browserOwners.set(sandboxId, owner);
      for (const peer of livePeers.get(sandboxId) ?? []) {
        if (peer.readyState === WebSocket.OPEN) peer.send(JSON.stringify({ type: "owner", owner }));
      }
      return sendJson(res, 200, { owner }, { "x-oh-daemon": "1" });
    }
    if (browserOwners.get(sandboxId) === "human" && routePath.startsWith("/browser/") && !new Set(["/browser/observe", "/browser/console_logs", "/browser/network_errors"]).has(routePath)) {
      return sendJson(res, 423, { error: "Browser is under human control" }, { "x-oh-daemon": "1" });
    }
    try {
      const owner = owners.get(sandboxId);
      if (req.method !== "GET" && req.method !== "HEAD" && owner) {
        res.once("finish", () => reclaimOwnership(path.join(root, sandboxId, "workspace"), owner));
      }
      const result = await daemon.handleRequest(req.method ?? "GET", url, {
        "x-session-key": sessionKey,
        "x-oh-request-id": String(req.headers["x-oh-request-id"] ?? ""),
      }, body);
      res.writeHead(result.status, { ...result.headers, "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(result.body));
    } catch (err) {
      sendJson(res, 500, { error: (err as Error).message }, { "x-oh-daemon": "1" });
    }
  });

  server.on("upgrade", (req, clientSocket, head) => {
    const liveUrl = new URL(req.url ?? "/", "http://127.0.0.1");
    if (liveUrl.pathname === "/live") {
      const origin = req.headers.origin;
      const isAllowedLiveOrigin =
        typeof origin === "string" &&
        (liveAllowedOrigins.has(origin) ||
          /^https:\/\/[a-z0-9-]+\.vercel\.app$/i.test(origin) ||
          /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/i.test(origin));
      if (!isAllowedLiveOrigin) {
        clientSocket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        clientSocket.destroy();
        return;
      }
      const token = liveUrl.searchParams.get("ticket") ?? "";
      const ticket = verifyLiveTicket(token, liveTicketKey);
      const now = Date.now();
      for (const [nonce, expiresAt] of usedNonces) if (expiresAt <= now) usedNonces.delete(nonce);
      if (!ticket || usedNonces.has(ticket.nonce) || (ticket.mode === "control" && browserOwners.get(ticket.sbx) !== "human")) {
        clientSocket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        clientSocket.destroy();
        return;
      }
      usedNonces.set(ticket.nonce, ticket.exp);
      const daemon = getOrCreateDaemon(ticket.sbx);
      webSocketServer.handleUpgrade(req, clientSocket, head, (socket) => {
        const peers = livePeers.get(ticket.sbx) ?? new Set<WebSocket>();
        peers.add(socket);
        livePeers.set(ticket.sbx, peers);
        const send = (data: unknown) => {
          if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(data));
        };
        const onFrame = (frame: unknown) => {
          if (socket.readyState !== WebSocket.OPEN || socket.bufferedAmount > 1_000_000) return;
          send({ type: "frame", ...(frame as Record<string, unknown>) });
        };
        const onPage = (page: unknown) => send({ type: "page", ...(page as Record<string, unknown>) });
        daemon.browser.on("frame", onFrame);
        daemon.browser.on("page", onPage);
        send({ type: "owner", owner: browserOwners.get(ticket.sbx) ?? "agent" });
        void daemon.browser.send("screencast_start", { quality: 60 });
        socket.on("message", (raw) => {
          if (ticket.mode !== "control" || browserOwners.get(ticket.sbx) !== "human") return;
          try {
            const msg = JSON.parse(String(raw)) as { type?: string; payload?: Record<string, unknown> };
            if (msg.type === "input" && msg.payload && browserOwners.get(ticket.sbx) === "human") {
              daemon.browser.post("input", msg.payload);
            }
          } catch {
            socket.close(1003, "Invalid message");
          }
        });
        socket.on("close", () => {
          daemon.browser.off("frame", onFrame);
          daemon.browser.off("page", onPage);
          peers.delete(socket);
          if (peers.size === 0) {
            livePeers.delete(ticket.sbx);
            void daemon.browser.send("screencast_stop");
          }
        });
        socket.on("error", () => {
          daemon.browser.off("frame", onFrame);
          daemon.browser.off("page", onPage);
        });
      });
      return;
    }
    const target = previewTarget(req.url);
    const wsKey = req.headers["x-session-key"];
    const wsAuthed = safeEquals(sessionKey, Array.isArray(wsKey) ? wsKey[0] : wsKey);
    const wsPortAllowed = target && (wsAuthed || Array.from(daemons.values()).some((d) => d.isRegisteredPreviewPort(target.port))) && !Array.from(daemons.values()).some((d) => d.isServicePort(target.port));
    if (!target || !wsPortAllowed) {
      clientSocket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      clientSocket.destroy();
      return;
    }
    const upstream = net.connect(target.port, "127.0.0.1");
    upstream.on("connect", () => {
      const lines = [`${req.method ?? "GET"} ${target.path} HTTP/${req.httpVersion}`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const name = req.rawHeaders[i]!;
        const value = name.toLowerCase() === "host" ? `127.0.0.1:${target.port}` : req.rawHeaders[i + 1]!;
        lines.push(`${name}: ${value}`);
      }
      upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on("error", () => {
      clientSocket.write("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
      clientSocket.destroy();
    });
    clientSocket.on("error", () => upstream.destroy());
  });

  const hub = server as SandboxHubServer;
  hub.daemons = daemons;
  hub.closeHub = async () => {
    for (const peers of livePeers.values()) for (const peer of peers) peer.close(1001, "Hub shutting down");
    livePeers.clear();
    webSocketServer.close();
    await Promise.all(Array.from(daemons.values(), (daemon) => daemon.close().catch(() => {})));
    daemons.clear();
    if (server.listening) await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  };
  return hub;
}

function parseArgs(args: string[]): Required<SandboxHubOptions> {
  const result: Required<SandboxHubOptions> = {
    host: "0.0.0.0",
    port: 8080,
    root: process.env.OH_WORKSPACES_ROOT ?? "/workspaces",
    sessionKey: requireKey(process.env.OH_MODAL_SANDBOX_KEY ?? process.env.OH_SESSION_KEY),
    liveAllowedOrigins: (process.env.OH_LIVE_ALLOWED_ORIGINS ?? "").split(",").map((origin) => origin.trim()).filter(Boolean),
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--host" && args[i + 1]) result.host = args[++i]!;
    else if (arg === "--port" && args[i + 1]) result.port = Number(args[++i]);
    else if (arg === "--root" && args[i + 1]) result.root = args[++i]!;
  }
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseArgs(process.argv.slice(2));
  const server = createSandboxHubServer(options);
  server.listen(options.port, options.host, () => {
    console.log(`[sandbox-hub] listening on ${options.host}:${options.port} (root=${options.root})`);
  });
}
