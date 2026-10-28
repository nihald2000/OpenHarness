import { NextResponse } from "next/server";
import { getAdminUrl, setSessionCookie, upstreamHeaders } from "@/lib/admin-session";
import { fetchOAuthProfile, oauthCallbackUrl, oauthCookieName, oauthErrorCode, openOAuthFlow, safeReturnTo, secureStringEqual, upsertOAuthUser, type AuthMode, type OAuthProvider } from "@/lib/oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function validProvider(value: string): value is OAuthProvider {
  return value === "google" || value === "github";
}

function clearFlowCookies(response: NextResponse, provider: OAuthProvider) {
  for (const mode of ["login", "signup"] as const) response.cookies.set(oauthCookieName(provider, mode), "", {
    httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 0,
  });
}

function loginRedirect(requestUrl: string, error: string, returnTo?: string) {
  const configured = process.env.OPENHARNESS_WEB_URL?.trim();
  let base = process.env.NODE_ENV === "production" ? "https://localhost" : new URL(requestUrl).origin;
  try { if (configured) base = new URL(configured).origin; } catch { /* keep a safe fallback origin */ }
  const target = new URL("/login", base);
  target.searchParams.set("error", error);
  if (returnTo) target.searchParams.set("returnTo", safeReturnTo(returnTo));
  return NextResponse.redirect(target);
}

function flowCookie(req: Request, provider: OAuthProvider, mode: AuthMode) {
  const prefix = `${oauthCookieName(provider, mode)}=`;
  return req.headers.get("cookie")?.split(";").map((part) => part.trim()).find((part) => part.startsWith(prefix))?.slice(prefix.length);
}

export async function GET(req: Request, context: { params: Promise<{ provider: string }> }): Promise<Response> {
  const { provider: rawProvider } = await context.params;
  if (!validProvider(rawProvider)) return loginRedirect(req.url, "provider_unavailable");
  const provider = rawProvider;
  const url = new URL(req.url);
  const returnedError = url.searchParams.get("error");
  if (returnedError) {
    const returnedState = url.searchParams.get("state");
    const returnedFlow = (["login", "signup"] as const).map((candidate) => {
      const flow = openOAuthFlow(provider, flowCookie(req, provider, candidate), candidate);
      return flow && returnedState && secureStringEqual(flow.state, returnedState) ? flow : undefined;
    }).find(Boolean);
    const response = loginRedirect(req.url, returnedFlow ? (returnedError === "access_denied" ? "oauth_cancelled" : "oauth_failed") : "oauth_invalid", returnedFlow?.returnTo);
    clearFlowCookies(response, provider);
    return response;
  }
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  if ((state && state.length > 128) || (code && code.length > 2_048)) {
    const response = loginRedirect(req.url, "oauth_invalid");
    clearFlowCookies(response, provider);
    return response;
  }
  let flow: ReturnType<typeof openOAuthFlow> = undefined;
  let mode: AuthMode | undefined;
  for (const candidate of ["login", "signup"] as const) {
    const value = openOAuthFlow(provider, flowCookie(req, provider, candidate), candidate);
    if (value && state && secureStringEqual(value.state, state)) { flow = value; mode = candidate; break; }
  }
  if (!flow || !mode || !state || !code) {
    const response = loginRedirect(req.url, "oauth_invalid");
    clearFlowCookies(response, provider);
    return response;
  }

  try {
    const adminToken = process.env.OPENHARNESS_ADMIN_TOKEN?.trim();
    if (!adminToken) throw new Error("OPENHARNESS_ADMIN_TOKEN is not configured");
    const callbackUrl = oauthCallbackUrl(provider, req.url);
    const verify = await fetch(`${getAdminUrl()}/v1/admin/verify`, {
      method: "POST", headers: upstreamHeaders(adminToken), cache: "no-store", signal: AbortSignal.timeout(10_000),
    });
    if (!verify.ok) throw new Error("The configured administrator token is not accepted by the OpenHarness server");
    const profile = await fetchOAuthProfile(provider, code, flow, callbackUrl);
    const user = await upsertOAuthUser(profile, mode);
    const response = NextResponse.redirect(new URL(flow.returnTo, callbackUrl));
    setSessionCookie(response, adminToken, req, user);
    clearFlowCookies(response, provider);
    return response;
  } catch (error) {
    const response = loginRedirect(req.url, oauthErrorCode(error), flow.returnTo);
    clearFlowCookies(response, provider);
    return response;
  }
}
