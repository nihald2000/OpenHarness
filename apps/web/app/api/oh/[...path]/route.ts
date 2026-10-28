import { NextRequest } from "next/server";
import { adminTokenFrom, getAdminUrl, json, sameOrigin, upstreamHeaders } from "@/lib/admin-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function resolveTargetPath(segments: string[]): string | null {
  if (segments.length === 0) return null;
  for (const seg of segments) {
    if (!seg || seg === "." || seg === "..") return null;
  }
  if (segments.length === 1 && segments[0] === "health") {
    return "/health";
  }
  if (segments[0] === "v1" && segments.length >= 2) {
    return "/" + segments.map((s) => encodeURIComponent(s)).join("/");
  }
  return null;
}

async function handle(
  req: NextRequest,
  context: { params: Promise<{ path: string[] }> }
): Promise<Response> {
  const { path: segments } = await context.params;
  const targetPath = resolveTargetPath(segments);
  if (!targetPath) {
    return json({ error: "not found" }, 404);
  }

  const isMutating = MUTATING.has(req.method);
  const originOk = sameOrigin(req);
  const adminToken = adminTokenFrom(req);

  if (targetPath !== "/health" && !adminToken) {
    return json({ error: "authentication required" }, 401);
  }

  if (isMutating && !originOk) {
    return json({ error: "bad origin" }, 403);
  }
  if (adminToken && !originOk) {
    return json({ error: "bad origin" }, 403);
  }

  const headers = new Headers(upstreamHeaders(originOk ? adminToken : undefined));
  const contentType = req.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);
  const accept = req.headers.get("accept");
  if (accept) headers.set("accept", accept);
  const contentEncoding = req.headers.get("content-encoding");
  if (contentEncoding) headers.set("content-encoding", contentEncoding);

  const isEvents = targetPath === "/v1/events";
  if (isEvents) {
    headers.set("accept", "text/event-stream");
    headers.set("cache-control", "no-cache");
    headers.set("x-accel-buffering", "no");
  }

  const search = req.nextUrl.search || "";
  const targetUrl = `${getAdminUrl()}${targetPath}${search}`;

  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  let body: ArrayBuffer | undefined;
  if (hasBody) {
    try {
      body = await req.arrayBuffer();
    } catch {
      return new Response(null, { status: 499 });
    }
  }

  let upstream: Response;
  try {
    upstream = await fetch(targetUrl, {
      method: req.method,
      headers,
      body: hasBody && body && body.byteLength > 0 ? body : undefined,
      signal: req.signal,
      cache: "no-store",
      redirect: "manual",
    });
  } catch (err) {
    if (req.signal.aborted || (err instanceof Error && err.name === "AbortError")) {
      return new Response(null, { status: 499 });
    }
    const details = err instanceof Error ? err.message : String(err);
    console.error(`[oh-proxy] ${req.method} ${targetUrl} failed: ${details}`);
    return json({ error: "OpenHarness server is unreachable" }, 502);
  }

  const resHeaders = new Headers();
  resHeaders.set("Cache-Control", "no-cache, no-transform");
  resHeaders.set("X-Accel-Buffering", "no");
  const upstreamType = upstream.headers.get("content-type");
  if (upstreamType) {
    resHeaders.set("Content-Type", upstreamType);
  }

  const nullBody =
    req.method === "HEAD" || upstream.status === 204 || upstream.status === 304;

  return new Response(nullBody ? null : upstream.body, {
    status: upstream.status,
    headers: resHeaders,
  });
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
