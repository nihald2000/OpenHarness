import { clearSessionCookie, json, sameOrigin } from "@/lib/admin-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  if (!sameOrigin(req)) {
    return json({ error: "bad origin" }, 403);
  }
  const res = json({ ok: true }, 200);
  clearSessionCookie(res);
  return res;
}
