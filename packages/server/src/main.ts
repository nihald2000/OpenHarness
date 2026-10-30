import http from "node:http";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { OpenHarnessServer, HttpError } from "./server.ts";
import { loadServerConfig, type LoadedServerConfig } from "./config.ts";

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
    try {
      const url = new URL(req.url ?? "/", "http://internal");
      if (url.pathname === "/health") {
        return send(res, 200, { ok: true, version: "0.2.0" });
      }
      const identity = await app.authenticate(req.headers);
      if (!identity) {
        return send(res, 401, { error: "unauthorized" });
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
        req.headers,
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
