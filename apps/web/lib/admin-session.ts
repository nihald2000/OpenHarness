import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { NextResponse } from "next/server";

export const ADMIN_COOKIE = "oh_admin";
const TTL_MS = 8 * 60 * 60 * 1000;
const TTL_SEC = 8 * 60 * 60;
const AAD = Buffer.from("oh_admin_v1", "utf8");
const WINDOW_MS = 5 * 60 * 1000;
const MAX_FAILURES = 10;
const MAX_TRACKED_IPS = 300;

interface AdminSessionState {
  key?: Buffer;
  failures: Map<string, number[]>;
}

export interface AuthenticatedUser {
  id: string;
  name: string;
  email: string;
  avatarUrl?: string;
  providers: Array<"google" | "github">;
  createdAt: number;
}

interface SessionPayload {
  token?: unknown;
  user?: AuthenticatedUser;
  exp?: unknown;
}

const GLOBAL_KEY = "__openharness_web_admin_session";

function getState(): AdminSessionState {
  const g = globalThis as unknown as Record<string, AdminSessionState | undefined>;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = { failures: new Map<string, number[]>() };
  }
  return g[GLOBAL_KEY];
}

function getKey(): Buffer {
  const state = getState();
  const secret = process.env.OPENHARNESS_WEB_SESSION_SECRET?.trim();
  if (secret) {
    return createHash("sha256").update(secret, "utf8").digest();
  }
  if (!state.key) {
    state.key = randomBytes(32);
  }
  return state.key;
}

export function sealOpaqueCookie(value: unknown, purpose: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getKey(), iv);
  cipher.setAAD(Buffer.from(`openharness_${purpose}_v1`, "utf8"));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return `${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${encrypted.toString("base64url")}`;
}

export function openOpaqueCookie<T>(value: string | undefined, purpose: string): T | undefined {
  if (!value || value.length > 8192) return undefined;
  const [ivValue, tagValue, encryptedValue, ...extra] = value.split(".");
  if (!ivValue || !tagValue || !encryptedValue || extra.length) return undefined;
  try {
    const iv = Buffer.from(ivValue, "base64url");
    const tag = Buffer.from(tagValue, "base64url");
    const encrypted = Buffer.from(encryptedValue, "base64url");
    if (iv.length !== 12 || tag.length !== 16 || encrypted.length < 2) return undefined;
    const decipher = createDecipheriv("aes-256-gcm", getKey(), iv);
    decipher.setAAD(Buffer.from(`openharness_${purpose}_v1`, "utf8"));
    decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8")) as T;
  } catch { return undefined; }
}

export function getAdminUrl(): string {
  const raw = process.env.OPENHARNESS_URL?.trim() || "http://127.0.0.1:4096";
  return raw.replace(/\/+$/, "");
}

export function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export function sealSession(token: string, now = Date.now(), user?: AuthenticatedUser): string {
  const key = getKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(AAD);
  const payload = JSON.stringify({ token, ...(user ? { user } : {}), exp: now + TTL_MS });
  const encrypted = Buffer.concat([cipher.update(payload, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64url")}.${tag.toString("base64url")}.${encrypted.toString("base64url")}`;
}

function openSessionPayload(cookieValue: string | undefined, now = Date.now()): SessionPayload | undefined {
  if (!cookieValue || cookieValue.length > 8192) return undefined;
  const parts = cookieValue.split(".");
  if (parts.length !== 3) return undefined;
  const [ivB64, tagB64, dataB64] = parts;
  if (!ivB64 || !tagB64 || !dataB64) return undefined;
  try {
    const iv = Buffer.from(ivB64, "base64url");
    const tag = Buffer.from(tagB64, "base64url");
    const encrypted = Buffer.from(dataB64, "base64url");
    if (iv.length !== 12 || tag.length !== 16 || encrypted.length < 2) return undefined;
    const decipher = createDecipheriv("aes-256-gcm", getKey(), iv);
    decipher.setAAD(AAD);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
    const parsed = JSON.parse(decrypted) as SessionPayload;
    if (typeof parsed.token !== "string" || !parsed.token) return undefined;
    if (typeof parsed.exp !== "number" || parsed.exp <= now) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function sessionCookieFrom(req: Request): string | undefined {
  const cookieHeader = req.headers.get("cookie");
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const idx = part.indexOf("=");
    if (idx !== -1 && part.slice(0, idx).trim() === ADMIN_COOKIE) return part.slice(idx + 1).trim();
  }
  return undefined;
}

export function openSession(cookieValue: string | undefined, now = Date.now()): string | undefined {
  const parsed = openSessionPayload(cookieValue, now);
  return typeof parsed?.token === "string" ? parsed.token : undefined;
}

export function authenticatedUserFrom(req: Request): AuthenticatedUser | undefined {
  const user = openSessionPayload(sessionCookieFrom(req))?.user;
  if (!user || typeof user.id !== "string" || typeof user.email !== "string" || typeof user.name !== "string") return undefined;
  return user;
}

export function adminTokenFrom(req: Request): string | undefined {
  return openSession(sessionCookieFrom(req));
}

export function setSessionCookie(res: NextResponse, token: string, req?: Request, user?: AuthenticatedUser): void {
  const sealed = sealSession(token, Date.now(), user);
  const proto = req?.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const isSecure = proto === "https" || process.env.NODE_ENV === "production";
  res.cookies.set(ADMIN_COOKIE, sealed, {
    httpOnly: true,
    sameSite: "lax",
    secure: isSecure,
    path: "/",
    maxAge: TTL_SEC,
  });
}

export function clearSessionCookie(res: NextResponse): void {
  res.cookies.set(ADMIN_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
}

export function sameOrigin(req: Request): boolean {
  const secFetchSite = req.headers.get("sec-fetch-site");
  // The browser's Sec-Fetch-Site header is authoritative and tamper-proof.
  // Trust it when present: same-origin / same-site are safe, cross-site is not.
  if (secFetchSite === "cross-site") return false;
  if (secFetchSite === "same-origin" || secFetchSite === "same-site") return true;
  // Sec-Fetch-Site is absent (non-browser client or older browser) – fall back
  // to comparing the Origin header against the host.
  const origin = req.headers.get("origin");
  if (!origin) return true;
  let originHost: string;
  try {
    originHost = new URL(origin).hostname.toLowerCase();
  } catch {
    return false;
  }
  const forwardedHost = req.headers.get("x-forwarded-host")?.split(",")[0]?.trim().toLowerCase();
  const host = req.headers.get("host")?.trim().toLowerCase();
  const expected = (forwardedHost || host)?.replace(/:\d+$/, "");
  if (!expected) return false;
  return originHost === expected;
}

export function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  const realIp = req.headers.get("x-real-ip")?.trim();
  if (realIp) return realIp;
  return "local";
}

function pruneIpFailures(ip: string, now: number): number[] {
  const { failures } = getState();
  const list = failures.get(ip);
  if (!list) return [];
  const recent = list.filter((ts) => now - ts < WINDOW_MS);
  if (recent.length === 0) {
    failures.delete(ip);
  } else {
    failures.set(ip, recent);
  }
  return recent;
}

export function failCount(ip: string, now = Date.now()): number {
  return pruneIpFailures(ip, now).length;
}

export function isRateLimited(ip: string, now = Date.now()): boolean {
  return failCount(ip, now) >= MAX_FAILURES;
}

export function recordFailure(ip: string, now = Date.now()): void {
  const { failures } = getState();
  const recent = pruneIpFailures(ip, now);
  recent.push(now);
  failures.delete(ip);
  failures.set(ip, recent);

  if (failures.size > MAX_TRACKED_IPS) {
    for (const [k, timestamps] of failures) {
      const active = timestamps.filter((t) => now - t < WINDOW_MS);
      if (active.length === 0) {
        failures.delete(k);
      } else {
        failures.set(k, active);
      }
      if (failures.size <= MAX_TRACKED_IPS) break;
    }
    while (failures.size > MAX_TRACKED_IPS) {
      const oldestKey = failures.keys().next().value;
      if (oldestKey === undefined) break;
      failures.delete(oldestKey);
    }
  }
}

export function clearFailures(ip: string): void {
  getState().failures.delete(ip);
}

export function upstreamHeaders(adminToken?: string): Record<string, string> {
  const headers: Record<string, string> = {};
  const serverToken = process.env.OPENHARNESS_SERVER_TOKEN?.trim();
  if (serverToken) {
    headers["authorization"] = `Bearer ${serverToken}`;
  }
  if (adminToken) {
    headers["x-openharness-admin"] = adminToken;
  }
  return headers;
}
