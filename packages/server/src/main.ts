import http from "node:http";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { OpenHarnessServer, HttpError } from "./server.ts";
import { loadServerConfig, type LoadedServerConfig } from "./config.ts";
import { MAX_ATTACHMENT_BYTES } from "./attachments.ts";
import { INTERNAL_HOLD_KEY } from "./keepalive.ts";

export const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
};

const send = (
  res: http.ServerResponse,
  status: number,
  body: unknown,
  extraHeaders?: Record<string, string>
) => {
  if (extraHeaders) {
    for (const [k, v] of Object.entries(extraHeaders)) {
      res.setHeader(k, v);
    }
  }
  res.writeHead(status, { "content-type": "application/json" });
  res.end(status === 204 ? undefined : JSON.stringify(body));
};

function sameSecret(value: unknown, expected: string): boolean {
  if (typeof value !== "string") return false;
  const actual = Buffer.from(value);
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && crypto.timingSafeEqual(actual, wanted);
}

export async function readJson(
  req: http.IncomingMessage,
  max: number
): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    const buf = Buffer.isBuffer(c) ? c : Buffer.from(c);
    size += buf.length;
    if (size > max) throw new HttpError(413, "request body too large");
    chunks.push(buf);
  }
  if (!size) return undefined;
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return v as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  throw new HttpError(400, "body must be a JSON object");
}

async function readRawBody(req: http.IncomingMessage, max: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    const buf = Buffer.isBuffer(c) ? c : Buffer.from(c);
    size += buf.length;
    if (size > max) throw new HttpError(413, "attachment is too large");
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

function isOriginAllowed(origin: string): boolean {
  const allowedList = process.env.OH_CORS_ORIGINS;
  const allowedRegex = process.env.OH_CORS_ORIGIN_REGEX;
  if (!allowedList && !allowedRegex) {
    return /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(origin);
  }
  if (allowedList) {
    const parts = allowedList.split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.includes(origin)) return true;
  }
  if (allowedRegex) {
    try {
      if (new RegExp(allowedRegex).test(origin)) return true;
    } catch {}
  }
  return false;
}

export function createHttpServer(
  app: OpenHarnessServer,
  cfg?: Partial<LoadedServerConfig>
): http.Server {
  const maxBodyBytes = cfg?.maxBodyBytes ?? 1_000_000;
  return http.createServer(async (req, res) => {
    const requestId = crypto.randomUUID();
    res.setHeader("x-request-id", requestId);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
      res.setHeader(k, v);
    }

    // CORS headers for Vercel -> Modal cross-origin requests (M13)
    const origin = req.headers.origin;
    if (origin && isOriginAllowed(origin)) {
      res.setHeader("access-control-allow-origin", origin);
      res.setHeader("access-control-allow-credentials", "true");
      res.setHeader("vary", "Origin");
      res.setHeader(
        "access-control-allow-headers",
        "Content-Type, Authorization, X-OpenHarness-Admin, X-Oh-Key, X-Audio-Filename, Last-Event-ID"
      );
      res.setHeader(
        "access-control-allow-methods",
        "GET, POST, PUT, PATCH, DELETE, OPTIONS"
      );
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      const url = new URL(req.url ?? "/", "http://internal");
      if (url.pathname === "/health") {
        const health = await app.handleRequest("GET", "/health", {});
        return send(res, health.status, health.body, health.headers);
      }
      if (req.method === "GET" && url.pathname === "/v1/internal/hold") {
        if (!sameSecret(req.headers["x-oh-internal"], INTERNAL_HOLD_KEY)) {
          return send(res, 404, { error: "Not found" });
        }
        const secs = Math.max(5, Math.min(Number(url.searchParams.get("secs") ?? 100) || 100, 120));
        res.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" });
        res.write("holding\n");
        const timer = setTimeout(() => res.end("released\n"), secs * 1000);
        res.on("close", () => clearTimeout(timer));
        return;
      }
      if (req.method === "GET" && url.pathname === "/v1/guest/session") {
        const guest = await app.createWebGuestSession(req.headers);
        return send(res, guest.status, guest.body, guest.headers);
      }
      const queryKey = url.searchParams.get("key");
      const authHeaders = queryKey
        ? { ...req.headers, "x-oh-key": queryKey }
        : req.headers;
      if (req.method === "GET" && url.pathname === "/v1/admin/session") {
        const identity = await app.authenticate(authHeaders as Record<string, string | undefined>);
        if (identity) {
          const out = await app.handleAuthenticatedRequest(
            identity,
            req.method,
            url,
            authHeaders as Record<string, string | undefined>
          );
          return send(res, out.status, out.body, out.headers);
        }
        const hasAdminCfg = Boolean(cfg?.adminToken ?? process.env.OPENHARNESS_ADMIN_TOKEN);
        const isOpenMode = (cfg?.authMode ?? process.env.OH_AUTH_MODE) === "open";
        return send(res, 200, {
          admin: false,
          authDisabled: isOpenMode || (!hasAdminCfg && cfg?.loopback !== false),
          user: null,
        });
      }
      if (req.method === "POST" && url.pathname === "/v1/admin/session") {
        const body = await readJson(req, maxBodyBytes);
        const out = await app.handleRequest(
          req.method,
          url.pathname + url.search,
          authHeaders as Record<string, string | undefined>,
          body
        );
        return send(res, out.status, out.body, out.headers);
      }
      const identity = await app.authenticate(authHeaders);
      if (!identity) {
        return send(res, 401, { error: "unauthorized" });
      }
      if (req.method === "POST" && url.pathname === "/v1/audio/transcribe") {
        const rawBody = await readRawBody(req, 4 * 1024 * 1024);
        const filenameHeader = req.headers["x-audio-filename"];
        const filename = Array.isArray(filenameHeader) ? filenameHeader[0] : filenameHeader;
        const out = await app.transcribeAudio(
          identity,
          rawBody,
          String(req.headers["content-type"] ?? ""),
          filename ? decodeURIComponent(filename) : undefined,
        );
        return send(res, out.status, out.body);
      }
      const rawFileMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/file\/raw$/);
      if (req.method === "GET" && rawFileMatch) {
        const sessionId = decodeURIComponent(rawFileMatch[1]!);
        const filePath = url.searchParams.get("path") ?? "";
        const file = await app.readSessionRawFile(identity, sessionId, filePath);
        if (file.status !== 200 || !file.buffer) return send(res, file.status, { error: file.error ?? "Could not read file" });
        const unsafeInlineMime = Boolean(file.mimeType && /^(?:text\/html|image\/svg\+xml|application\/xhtml\+xml|text\/xml|application\/xml)/i.test(file.mimeType));
        const forceAttachment = url.searchParams.get("download") === "1" || unsafeInlineMime;
        const safeName = (file.filename ?? "download").replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_");
        res.writeHead(200, {
          "content-type": file.mimeType ?? "application/octet-stream",
          "content-length": String(file.buffer.byteLength),
          "content-disposition": `${forceAttachment ? "attachment" : "inline"}; filename="${safeName}"`,
          "content-security-policy": "default-src 'none'; sandbox",
          "x-content-type-options": "nosniff",
          "cache-control": "private, no-store",
        });
        return res.end(file.buffer);
      }
      const rawAttachmentMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/attachments\/([^/]+)\/raw$/);
      if (req.method === "GET" && rawAttachmentMatch) {
        const sessionId = decodeURIComponent(rawAttachmentMatch[1]!);
        if (!(await app.stateStore.getSession(identity.tenantId, sessionId))) return send(res, 404, { error: "Session not found" });
        const attachment = app.attachments.get(identity.tenantId, sessionId, decodeURIComponent(rawAttachmentMatch[2]!));
        if (!attachment) return send(res, 404, { error: "Attachment not found" });
        const safeName = attachment.info.name.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_");
        const safeInlineAttachment = /^(?:image\/(?:png|jpeg|webp|gif)|application\/pdf)$/i.test(attachment.info.mimeType);
        res.writeHead(200, {
          "content-type": safeInlineAttachment ? attachment.info.mimeType : "application/octet-stream",
          "content-length": String(attachment.data.byteLength),
          "content-disposition": `${safeInlineAttachment ? "inline" : "attachment"}; filename="${safeName}"`,
          "content-security-policy": "default-src 'none'; sandbox",
          "x-content-type-options": "nosniff",
          "cache-control": "private, no-store",
        });
        return res.end(attachment.data);
      }
      const attachmentRoute = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/attachments$/);
      if (req.method === "POST" && attachmentRoute) {
        const rawBody = await readRawBody(req, MAX_ATTACHMENT_BYTES);
        const out = await app.handleAuthenticatedRequest(
          identity,
          req.method,
          url,
          authHeaders,
          undefined,
          rawBody
        );
        return send(res, out.status, out.body, out.headers);
      }
      if (url.pathname === "/v1/events") {
        await app.streamEvents(identity, url, req, res);
        return;
      }
      if (req.method === "GET" && url.pathname === "/v1/runtimes") {
        return send(res, 200, await app.listRuntimes());
      }
      const body =
        req.method === "GET" || req.method === "HEAD"
          ? undefined
          : await readJson(req, maxBodyBytes);
      const out = await app.handleAuthenticatedRequest(
        identity,
        req.method ?? "GET",
        url,
        authHeaders,
        body
      );
      send(res, out.status, out.body, out.headers);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      app.log.error({ requestId, err }, "request failed");
      send(res, status, {
        error: status === 500 ? "internal error" : (err as Error).message,
        requestId,
      });
    }
  });
}

const isMain =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  const cfg = loadServerConfig(process.env);
  const app = new OpenHarnessServer(cfg);
  await app.start();
  const srv = createHttpServer(app, cfg);
  srv.listen(cfg.port, cfg.host, () =>
    app.log.info(`OpenHarness listening on http://${cfg.host}:${cfg.port}`)
  );
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () =>
      void app.stop().finally(() => {
        srv.close(() => process.exit(0));
      })
    );
  }
}
