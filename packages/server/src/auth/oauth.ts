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
    if (match?.[1]) {
      const [sessionId, sig] = match[1].split(".");
      if (sessionId && sig) {
        const expected = crypto.createHmac("sha256", this.secret).update(sessionId).digest("base64url");
        const a = Buffer.from(sig);
        const b = Buffer.from(expected);
        if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
          const rec = this.sessions.get(sessionId);
          if (rec && rec.expiresAt >= Date.now()) return rec;
          this.sessions.delete(sessionId);
        }
      }
    }

    const guestMatch = /(?:^|;\s*)oh_guest=([^;]+)/.exec(cookieHeader);
    if (!guestMatch?.[1]) return null;
    const [guestId, expiresAtRaw, sig] = guestMatch[1].split(".");
    const expiresAt = Number(expiresAtRaw);
    if (!guestId || !Number.isSafeInteger(expiresAt) || expiresAt <= Date.now() || !sig) return null;
    const payload = `${guestId}.${expiresAt}`;
    const expected = crypto.createHmac("sha256", this.secret).update(payload).digest("base64url");
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    return {
      sessionId: `guest_${guestId}`,
      tenantId: `guest_${guestId}`,
      userId: `guest_${guestId}`,
      admin: false,
      expiresAt,
    };
  }

  issueGuestCookie(ttlMs = 30 * 24 * 60 * 60 * 1000, secure = false): { cookieHeader: string; token: string } {
    const guestId = crypto.randomBytes(24).toString("hex");
    const expiresAt = Date.now() + ttlMs;
    const payload = `${guestId}.${expiresAt}`;
    const sig = crypto.createHmac("sha256", this.secret).update(payload).digest("base64url");
    const token = `${payload}.${sig}`;
    const cookieHeader = `oh_guest=${token}; HttpOnly; Path=/; Max-Age=${Math.floor(ttlMs / 1000)}; SameSite=Lax${secure ? "; Secure" : ""}`;
    return { cookieHeader, token };
  }
}
