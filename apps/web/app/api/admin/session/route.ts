import { adminTokenFrom, json } from "@/lib/admin-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const token = adminTokenFrom(req);
  return json({ admin: Boolean(token) }, 200);
}
