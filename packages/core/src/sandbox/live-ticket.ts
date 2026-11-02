import crypto from "node:crypto";

export type LiveTicket = {
  sbx: string;
  mode: "view" | "control";
  exp: number;
  nonce: string;
};

const SANDBOX_ID = /^[A-Za-z0-9_-]{3,96}$/;
const ticketMac = (payload: string, key: string): Buffer =>
  crypto.createHmac("sha256", `oh-live:${key}`).update(payload).digest();

export function signLiveTicket(
  sbx: string,
  mode: LiveTicket["mode"],
  key: string,
  ttlMs = 60_000
): string {
  if (!SANDBOX_ID.test(sbx)) throw new Error("Invalid sandbox id for live ticket");
  if (mode !== "view" && mode !== "control") throw new Error("Invalid live ticket mode");
  if (!key || key.length < 32) throw new Error("Live ticket signing key must be at least 32 characters");
  const ttl = Math.max(1, Math.min(60_000, Math.floor(ttlMs)));
  const payload = Buffer.from(JSON.stringify({
    sbx,
    mode,
    exp: Date.now() + ttl,
    nonce: crypto.randomBytes(16).toString("hex"),
  })).toString("base64url");
  return `${payload}.${ticketMac(payload, key).toString("base64url")}`;
}

export function verifyLiveTicket(ticket: string, key: string): LiveTicket | null {
  const [payload, encodedMac, extra] = ticket.split(".");
  if (!payload || !encodedMac || extra !== undefined || !key || key.length < 32) return null;
  let supplied: Buffer;
  try { supplied = Buffer.from(encodedMac, "base64url"); } catch { return null; }
  const expected = ticketMac(payload, key);
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) return null;
  try {
    const value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Partial<LiveTicket>;
    if (
      typeof value.sbx !== "string" || !SANDBOX_ID.test(value.sbx) ||
      (value.mode !== "view" && value.mode !== "control") ||
      typeof value.exp !== "number" || !Number.isFinite(value.exp) ||
      value.exp <= Date.now() || value.exp > Date.now() + 60_000 ||
      typeof value.nonce !== "string" || !/^[a-f0-9]{32}$/.test(value.nonce)
    ) return null;
    return value as LiveTicket;
  } catch {
    return null;
  }
}
