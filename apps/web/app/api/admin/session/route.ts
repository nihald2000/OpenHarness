import { adminTokenFrom, authenticatedUserFrom, json } from "@/lib/admin-session";
import { authDisabled } from "@/lib/auth-mode";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  if (authDisabled()) {
    return json({ admin: true, user: null, authDisabled: true }, 200);
  }
  const token = adminTokenFrom(req);
  return json(
    {
      admin: Boolean(token),
      user: token ? authenticatedUserFrom(req) ?? null : null,
      authDisabled: false,
    },
    200
  );
}
