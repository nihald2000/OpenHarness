import {
  clearFailures,
  clientIp,
  getAdminUrl,
  isRateLimited,
  json,
  recordFailure,
  sameOrigin,
  setSessionCookie,
  upstreamHeaders,
} from "@/lib/admin-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  if (!sameOrigin(req)) {
    return json({ error: "bad origin" }, 403);
  }

  const ip = clientIp(req);
  if (isRateLimited(ip)) {
    return json(
      { error: "Too many failed sign-in attempts. Try again in a few minutes." },
      429
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid request body" }, 400);
  }

  if (!body || typeof body !== "object") {
    return json({ error: "Invalid request body" }, 400);
  }

  const rawToken = (body as { token?: unknown }).token;
  if (typeof rawToken !== "string" || !rawToken.trim()) {
    return json({ error: "Admin token is required" }, 400);
  }
  const token = rawToken.trim();

  let upstream: Response;
  try {
    upstream = await fetch(`${getAdminUrl()}/v1/admin/verify`, {
      method: "POST",
      headers: upstreamHeaders(token),
      signal: AbortSignal.timeout(10_000),
      cache: "no-store",
    });
  } catch {
    return json({ error: "OpenHarness server is unreachable" }, 502);
  }

  if (upstream.status === 401 || upstream.status === 403) {
    recordFailure(ip);
    return json({ error: "Invalid admin token" }, 401);
  }

  if (!upstream.ok) {
    return json(
      { error: `Could not verify the admin token (server responded ${upstream.status})` },
      500
    );
  }

  clearFailures(ip);
  const res = json({ ok: true }, 200);
  setSessionCookie(res, token, req);
  return res;
}
