import { createHash, createPublicKey, randomBytes, randomUUID, timingSafeEqual, verify } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { AuthenticatedUser } from "./admin-session";
import { openOpaqueCookie, sealOpaqueCookie } from "./admin-session";

export type OAuthProvider = "google" | "github";
export type AuthMode = "login" | "signup";
export const OAUTH_COOKIE_TTL_SEC = 10 * 60;

type OAuthFlow = { provider: OAuthProvider; state: string; verifier: string; nonce: string; returnTo: string; mode: AuthMode; exp: number };
type ProviderIdentity = { provider: OAuthProvider; providerId: string };
type UserRecord = AuthenticatedUser & { identities: ProviderIdentity[]; updatedAt: number };
type AccountFile = { version: 1; users: UserRecord[] };
export type OAuthProfile = { provider: OAuthProvider; providerId: string; email: string; name: string; avatarUrl?: string };

const providerCookie = (provider: OAuthProvider) => `oh_oauth_${provider}`;
const accountFile = () => resolve(process.env.OPENHARNESS_AUTH_DATA_DIR?.trim() || process.env.OPENHARNESS_DATA_DIR?.trim() || ".openharness-auth", "web-users.json");

export function providerConfigured(provider: OAuthProvider) {
  return provider === "google"
    ? Boolean(process.env.GOOGLE_CLIENT_ID?.trim() && process.env.GOOGLE_CLIENT_SECRET?.trim())
    : Boolean(process.env.GITHUB_CLIENT_ID?.trim() && process.env.GITHUB_CLIENT_SECRET?.trim());
}

export function oauthProviders() {
  return { google: providerConfigured("google"), github: providerConfigured("github") };
}

function appBaseUrl(requestUrl: string) {
  const configured = process.env.OPENHARNESS_WEB_URL?.trim();
  if (configured) {
    const url = new URL(configured);
    if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") throw new Error("OPENHARNESS_WEB_URL must use HTTPS outside localhost");
    return url.origin;
  }
  if (process.env.NODE_ENV === "production") throw new Error("OPENHARNESS_WEB_URL must be configured for OAuth in production");
  return new URL(requestUrl).origin;
}

export function oauthCallbackUrl(provider: OAuthProvider, requestUrl: string) {
  return `${appBaseUrl(requestUrl)}/api/auth/${provider}/callback`;
}

export function safeReturnTo(value: string | null | undefined) {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\") || value.startsWith("/api/")) return "/";
  try {
    const parsed = new URL(value, "https://openharness.invalid");
    return parsed.origin === "https://openharness.invalid" ? `${parsed.pathname}${parsed.search}${parsed.hash}` : "/";
  } catch { return "/"; }
}

export function createOAuthFlow(provider: OAuthProvider, returnTo: string, mode: AuthMode): { flow: OAuthFlow; challenge: string; cookie: string } {
  const verifier = randomBytes(32).toString("base64url");
  const flow: OAuthFlow = {
    provider, state: randomBytes(32).toString("base64url"), verifier,
    nonce: randomBytes(32).toString("base64url"),
    returnTo: safeReturnTo(returnTo), mode,
    exp: Date.now() + OAUTH_COOKIE_TTL_SEC * 1000,
  };
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { flow, challenge, cookie: sealOpaqueCookie(flow, `oauth_${provider}_${mode}`) };
}

export function openOAuthFlow(provider: OAuthProvider, cookie: string | undefined, mode: AuthMode): OAuthFlow | undefined {
  const flow = openOpaqueCookie<OAuthFlow>(cookie, `oauth_${provider}_${mode}`);
  if (!flow || flow.provider !== provider || flow.mode !== mode || flow.exp <= Date.now() || !flow.state || !flow.verifier || !flow.nonce) return undefined;
  return flow;
}

export function oauthCookieName(provider: OAuthProvider, mode: AuthMode) {
  return `${providerCookie(provider)}_${mode}`;
}

export function secureStringEqual(left: string, right: string) {
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function parseJwtPart(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid identity token");
  return parsed as Record<string, unknown>;
}

let googleKeys: { expiresAt: number; keys: Array<JsonWebKey & { kid?: string; alg?: string; use?: string }> } | undefined;
type JsonWebKey = { kty?: string; n?: string; e?: string; [key: string]: unknown };

async function verifyGoogleIdToken(token: string, nonce: string) {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Invalid Google identity response");
  const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string];
  const header = parseJwtPart(encodedHeader); const claims = parseJwtPart(encodedPayload);
  if (header.alg !== "RS256" || typeof header.kid !== "string") throw new Error("Unsupported Google identity signature");
  if (!googleKeys || googleKeys.expiresAt < Date.now()) {
    const response = await fetch("https://www.googleapis.com/oauth2/v3/certs", { cache: "no-store", signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error("Could not verify Google identity");
    const payload = await response.json() as { keys?: Array<JsonWebKey & { kid?: string; alg?: string; use?: string }> };
    if (!Array.isArray(payload.keys)) throw new Error("Could not verify Google identity");
    const cacheAge = Number(response.headers.get("cache-control")?.match(/max-age=(\d+)/i)?.[1] ?? 3600);
    googleKeys = { keys: payload.keys, expiresAt: Date.now() + Math.min(Math.max(cacheAge, 60), 3600) * 1000 };
  }
  const jwk = googleKeys.keys.find((key) => key.kid === header.kid && key.kty === "RSA");
  if (!jwk) { googleKeys.expiresAt = 0; throw new Error("Google identity signing key is not recognized"); }
  const publicKey = createPublicKey({ key: jwk, format: "jwk" });
  if (!verify("RSA-SHA256", Buffer.from(`${encodedHeader}.${encodedPayload}`), publicKey, Buffer.from(encodedSignature, "base64url"))) throw new Error("Google identity signature is invalid");
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const audience = claims.aud;
  if (claims.iss !== "https://accounts.google.com" && claims.iss !== "accounts.google.com") throw new Error("Google identity issuer is invalid");
  if (!(audience === clientId || (Array.isArray(audience) && audience.includes(clientId)))) throw new Error("Google identity audience is invalid");
  if (Array.isArray(audience) && audience.length > 1 && claims.azp !== clientId) throw new Error("Google identity authorized party is invalid");
  if (typeof claims.exp !== "number" || claims.exp * 1000 <= Date.now()) throw new Error("Google identity token expired");
  if (typeof claims.iat !== "number" || claims.iat * 1000 > Date.now() + 60_000) throw new Error("Google identity token is not valid yet");
  if (claims.nonce !== nonce) throw new Error("Google identity nonce did not match");
  if (claims.email_verified !== true || typeof claims.email !== "string" || typeof claims.sub !== "string" || claims.sub.length > 255) throw new Error("Google account must have a verified email address");
  if (typeof claims.name !== "string" || !claims.name.trim()) claims.name = claims.email;
  const avatarUrl = typeof claims.picture === "string" && claims.picture.startsWith("https://") && claims.picture.length <= 2048 ? claims.picture : undefined;
  return { provider: "google" as const, providerId: claims.sub, email: claims.email, name: claims.name as string, ...(avatarUrl ? { avatarUrl } : {}) };
}

async function exchangeCode(provider: OAuthProvider, code: string, flow: OAuthFlow, callbackUrl: string) {
  const google = provider === "google";
  const tokenUrl = google ? "https://oauth2.googleapis.com/token" : "https://github.com/login/oauth/access_token";
  const clientId = (google ? process.env.GOOGLE_CLIENT_ID : process.env.GITHUB_CLIENT_ID)?.trim();
  const clientSecret = (google ? process.env.GOOGLE_CLIENT_SECRET : process.env.GITHUB_CLIENT_SECRET)?.trim();
  const body = new URLSearchParams({ grant_type: "authorization_code", client_id: clientId!, client_secret: clientSecret!, code, redirect_uri: callbackUrl, code_verifier: flow.verifier });
  const response = await fetch(tokenUrl, { method: "POST", headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded", ...(google ? {} : { "user-agent": "OpenHarness" }) }, body, cache: "no-store", signal: AbortSignal.timeout(10_000) });
  const data = await response.json() as Record<string, unknown>;
  if (!response.ok || typeof data.access_token !== "string") throw new Error("The provider could not complete sign-in");
  return data;
}

export async function fetchOAuthProfile(provider: OAuthProvider, code: string, flow: OAuthFlow, callbackUrl: string): Promise<OAuthProfile> {
  const token = await exchangeCode(provider, code, flow, callbackUrl);
  if (provider === "google") {
    if (typeof token.id_token !== "string") throw new Error("Google did not return an identity token");
    return verifyGoogleIdToken(token.id_token, flow.nonce);
  }
  const accessToken = token.access_token as string;
  const headers = { authorization: `Bearer ${accessToken}`, accept: "application/vnd.github+json", "user-agent": "OpenHarness", "x-github-api-version": "2022-11-28" };
  const [userResponse, emailResponse] = await Promise.all([
    fetch("https://api.github.com/user", { headers, cache: "no-store", signal: AbortSignal.timeout(10_000) }),
    fetch("https://api.github.com/user/emails", { headers, cache: "no-store", signal: AbortSignal.timeout(10_000) }),
  ]);
  if (!userResponse.ok || !emailResponse.ok) throw new Error("Could not read the GitHub account profile");
  const user = await userResponse.json() as { id?: unknown; login?: unknown; name?: unknown; avatar_url?: unknown };
  const emails = await emailResponse.json() as Array<{ email?: unknown; primary?: unknown; verified?: unknown }>;
  const primary = Array.isArray(emails) ? emails.find((entry) => entry.primary === true && entry.verified === true && typeof entry.email === "string") : undefined;
  if ((typeof user.id !== "number" && typeof user.id !== "string") || !primary || typeof primary.email !== "string") throw new Error("GitHub account must have a primary verified email address");
  const name = typeof user.name === "string" && user.name.trim() ? user.name.trim() : typeof user.login === "string" ? user.login : primary.email;
  const avatarUrl = typeof user.avatar_url === "string" && user.avatar_url.startsWith("https://") ? user.avatar_url : undefined;
  return { provider, providerId: String(user.id), email: primary.email, name, ...(avatarUrl ? { avatarUrl } : {}) };
}

let accountQueue: Promise<unknown> = Promise.resolve();

async function readAccounts(): Promise<AccountFile> {
  try {
    const file = accountFile();
    const stat = await readFile(file, "utf8");
    if (stat.length > 5_000_000) throw new Error("account store is too large");
    const data = JSON.parse(stat) as AccountFile;
    if (data.version !== 1 || !Array.isArray(data.users)) throw new Error("account store format is invalid");
    return data;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, users: [] };
    throw error;
  }
}

function withAccountLock<T>(operation: () => Promise<T>): Promise<T> {
  const next = accountQueue.then(operation, operation);
  accountQueue = next.then(() => undefined, () => undefined);
  return next;
}

async function saveAccounts(data: AccountFile) {
  const file = accountFile();
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(data), { mode: 0o600 });
  await rename(temporary, file);
}

function signupAllowed(email: string) {
  const allowlist = (process.env.OPENHARNESS_AUTH_ALLOWED_EMAILS ?? "").split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
  if (allowlist.length) return allowlist.includes(email.toLowerCase());
  return process.env.OPENHARNESS_AUTH_ALLOW_SIGNUP?.trim().toLowerCase() === "true";
}

function emailAllowedByPolicy(email: string) {
  const allowlist = (process.env.OPENHARNESS_AUTH_ALLOWED_EMAILS ?? "").split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
  return allowlist.length === 0 || allowlist.includes(email.toLowerCase());
}

export function signupPolicyEnabled() {
  const allowlist = (process.env.OPENHARNESS_AUTH_ALLOWED_EMAILS ?? "").split(",").map((item) => item.trim()).filter(Boolean);
  return allowlist.length > 0 || process.env.OPENHARNESS_AUTH_ALLOW_SIGNUP?.trim().toLowerCase() === "true";
}

export async function upsertOAuthUser(profile: OAuthProfile, mode: AuthMode): Promise<AuthenticatedUser> {
  return withAccountLock(async () => {
    const data = await readAccounts();
    const normalizedEmail = profile.email.trim().toLowerCase();
    if (normalizedEmail.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail) || profile.providerId.length > 255) throw new Error("The provider returned an invalid account profile");
    const safeName = profile.name.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 120) || profile.email.slice(0, 120);
    const avatarUrl = profile.avatarUrl?.startsWith("https://") && profile.avatarUrl.length <= 2048 ? profile.avatarUrl : undefined;
    if (!emailAllowedByPolicy(normalizedEmail)) throw new Error("Account registration is disabled or your email is not invited.");
    const identity = data.users.find((user) => user.identities.some((item) => item.provider === profile.provider && item.providerId === profile.providerId));
    const existing = identity ?? data.users.find((user) => user.email.toLowerCase() === normalizedEmail);
    if (!existing && mode === "login") throw new Error("No account is registered for that provider. Create an account first.");
    if (!existing && !signupAllowed(normalizedEmail)) throw new Error("Account registration is disabled or your email is not invited.");
    const now = Date.now();
    if (existing) {
      if (!existing.identities.some((item) => item.provider === profile.provider && item.providerId === profile.providerId)) existing.identities.push({ provider: profile.provider, providerId: profile.providerId });
      existing.email = profile.email;
      existing.name = safeName;
      if (avatarUrl) existing.avatarUrl = avatarUrl;
      existing.providers = [...new Set(existing.identities.map((item) => item.provider))];
      existing.updatedAt = now;
      await saveAccounts(data);
      const { identities: _identities, updatedAt: _updatedAt, ...user } = existing;
      return user;
    }
    const created: UserRecord = {
      id: randomUUID(), name: safeName, email: profile.email.trim(),
      ...(avatarUrl ? { avatarUrl } : {}),
      providers: [profile.provider], identities: [{ provider: profile.provider, providerId: profile.providerId }], createdAt: now, updatedAt: now,
    };
    data.users.push(created);
    await saveAccounts(data);
    const { identities: _identities, updatedAt: _updatedAt, ...user } = created;
    return user;
  });
}

export function oauthErrorCode(error: unknown) {
  if (error instanceof Error && /No account is registered/i.test(error.message)) return "account_not_found";
  if (error instanceof Error && /registration is disabled|not invited/i.test(error.message)) return "signup_disabled";
  if (error instanceof Error && /OPENHARNESS_WEB_URL|not configured|OAuth in production/i.test(error.message)) return "oauth_setup";
  if (error instanceof Error && /administrator token is not accepted/i.test(error.message)) return "admin_token_invalid";
  return "oauth_failed";
}
