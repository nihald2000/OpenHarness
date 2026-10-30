import crypto from "node:crypto";

export interface CookieSession {
  sessionId: string;
  tenantId: string;
  userId: string;
  admin: boolean;
  expiresAt: number;
}

export class CookieSessionStore {
  private readonly sessions = new Map<string, CookieSession>();
  private readonly secret: string;

  constructor(secret = crypto.randomBytes(32).toString("hex")) {
    this.secret = secret;
  }

  issueCookie(session: Omit<CookieSession, "sessionId" | "expiresAt">, ttlMs = 86_400_000, secure = false): { cookieHeader: string; token: string } {
    const sessionId = crypto.randomBytes(24).toString("hex");
    const record: CookieSession = {
      ...session,
      sessionId,
      expiresAt: Date.now() + ttlMs,
    };
    const sig = crypto.createHmac("sha256", this.secret).update(sessionId).digest("base64url");
    const token = `${sessionId}.${sig}`;
    this.sessions.set(sessionId, record);
    const cookieHeader = `oh_session=${token}; HttpOnly; Path=/; SameSite=Lax${secure ? "; Secure" : ""}`;
    return { cookieHeader, token };
  }

  async fromCookie(cookieHeader?: string): Promise<CookieSession | null> {
    if (!cookieHeader) return null;
    const match = /(?:^|;\s*)oh_session=([^;]+)/.exec(cookieHeader);
    if (!match?.[1]) return null;
    const [sessionId, sig] = match[1].split(".");
    if (!sessionId || !sig) return null;
    const expected = crypto.createHmac("sha256", this.secret).update(sessionId).digest("base64url");
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const rec = this.sessions.get(sessionId);
    if (!rec || rec.expiresAt < Date.now()) {
      this.sessions.delete(sessionId);
      return null;
    }
    return rec;
  }
}
