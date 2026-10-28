import { NextResponse } from "next/server";
import { oauthCookieName, createOAuthFlow, oauthCallbackUrl, oauthProviders, type AuthMode, type OAuthProvider } from "@/lib/oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function validProvider(value: string): value is OAuthProvider {
  return value === "google" || value === "github";
}

export async function GET(req: Request, context: { params: Promise<{ provider: string }> }): Promise<Response> {
  const { provider: rawProvider } = await context.params;
  const loginUrl = new URL("/login", req.url);
  if (!validProvider(rawProvider)) {
    loginUrl.searchParams.set("error", "provider_unavailable");
    return NextResponse.redirect(loginUrl);
  }
  const provider = rawProvider;
  if (!oauthProviders()[provider]) {
    loginUrl.searchParams.set("error", "provider_unavailable");
    return NextResponse.redirect(loginUrl);
  }
  if (!process.env.OPENHARNESS_ADMIN_TOKEN?.trim()) {
    loginUrl.searchParams.set("error", "oauth_setup");
    return NextResponse.redirect(loginUrl);
  }
  if (process.env.NODE_ENV === "production" && !process.env.OPENHARNESS_WEB_SESSION_SECRET?.trim()) {
    loginUrl.searchParams.set("error", "oauth_setup");
    return NextResponse.redirect(loginUrl);
  }
  const url = new URL(req.url);
  const mode: AuthMode = url.searchParams.get("mode") === "signup" ? "signup" : "login";
  let callbackUrl: string;
  try { callbackUrl = oauthCallbackUrl(provider, req.url); }
  catch {
    loginUrl.searchParams.set("error", "oauth_setup");
    return NextResponse.redirect(loginUrl);
  }
  const { flow, challenge, cookie } = createOAuthFlow(provider, url.searchParams.get("returnTo") ?? "/", mode);
  const clientId = (provider === "google" ? process.env.GOOGLE_CLIENT_ID : process.env.GITHUB_CLIENT_ID)!.trim();
  const authorization = new URL(provider === "google" ? "https://accounts.google.com/o/oauth2/v2/auth" : "https://github.com/login/oauth/authorize");
  authorization.searchParams.set("client_id", clientId);
  authorization.searchParams.set("redirect_uri", callbackUrl);
  authorization.searchParams.set("response_type", "code");
  authorization.searchParams.set("scope", provider === "google" ? "openid email profile" : "read:user user:email");
  authorization.searchParams.set("state", flow.state);
  authorization.searchParams.set("code_challenge", challenge);
  authorization.searchParams.set("code_challenge_method", "S256");
  if (provider === "google") {
    authorization.searchParams.set("nonce", flow.nonce);
    authorization.searchParams.set("prompt", "select_account");
  } else {
    authorization.searchParams.set("allow_signup", "true");
    authorization.searchParams.set("prompt", "select_account");
  }
  const response = NextResponse.redirect(authorization);
  response.cookies.set(oauthCookieName(provider, mode), cookie, {
    httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 600,
  });
  return response;
}
