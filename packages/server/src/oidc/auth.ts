import crypto from "node:crypto";

export interface OidcConfig {
  issuer: string;
  audience: string;
  hs256Secret?: string;
}

export interface VerifiedOidcClaims {
  tenantId: string;
  userId: string;
  admin: boolean;
  email?: string;
}

export class OidcVerifier {
  private readonly cfg: OidcConfig;
  constructor(cfg: OidcConfig) {
    this.cfg = cfg;
  }

  async verify(jwt: string): Promise<VerifiedOidcClaims> {
    if (!this.cfg.hs256Secret || this.cfg.hs256Secret.trim().length === 0) {
      throw new Error("OIDC HS256 secret is required for JWT verification");
    }
    const parts = jwt.split(".");
    if (parts.length !== 3) throw new Error("invalid JWT structure");
    const [headerB64, payloadB64, sigB64] = parts as [string, string, string];
    if (!headerB64 || !payloadB64 || !sigB64) {
      throw new Error("invalid JWT structure");
    }
    let header: Record<string, unknown>;
    try {
      header = JSON.parse(Buffer.from(headerB64, "base64url").toString("utf8")) as Record<string, unknown>;
    } catch {
      throw new Error("invalid JWT header");
    }
    if (!header || header.alg !== "HS256") {
      throw new Error("unsupported JWT algorithm");
    }
    const expected = crypto
      .createHmac("sha256", this.cfg.hs256Secret)
      .update(`${headerB64}.${payloadB64}`)
      .digest("base64url");
    const a = Buffer.from(sigB64);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      throw new Error("invalid JWT signature");
    }
    const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
    if (payload.iss !== this.cfg.issuer) throw new Error("JWT issuer mismatch");
    const audMatch = Array.isArray(payload.aud)
      ? payload.aud.includes(this.cfg.audience)
      : payload.aud === this.cfg.audience;
    if (!audMatch) throw new Error("JWT audience mismatch");
    if (typeof payload.nbf === "number" && payload.nbf * 1000 > Date.now()) {
      throw new Error("JWT not yet valid");
    }
    if (typeof payload.exp === "number" && payload.exp * 1000 < Date.now()) {
      throw new Error("JWT expired");
    }
    return {
      tenantId: String(payload.tenant_id ?? payload.org_id ?? "default"),
      userId: String(payload.sub ?? "user"),
      admin: Boolean(payload.admin === true || payload.role === "admin"),
      email: typeof payload.email === "string" ? payload.email : undefined,
    };
  }
}
