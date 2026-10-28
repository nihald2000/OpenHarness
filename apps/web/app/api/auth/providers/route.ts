import { json } from "@/lib/admin-session";
import { oauthProviders, signupPolicyEnabled } from "@/lib/oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return json({
    providers: oauthProviders(),
    signupEnabled: signupPolicyEnabled(),
    adminTokenConfigured: Boolean(process.env.OPENHARNESS_ADMIN_TOKEN?.trim()),
  });
}
