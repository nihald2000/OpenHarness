export interface LoadedServerConfig {
  host: string;
  port: number;
  loopback: boolean;
  authMode?: "open" | "token";
  accessKey?: string;
  serverToken?: string;
  adminToken?: string;
  oidc?: { issuer: string; audience: string; hs256Secret?: string };
  serviceTenantId: string;
  maxBodyBytes: number;
  dataDir: string;
}

export function loadServerConfig(env: NodeJS.ProcessEnv = process.env): LoadedServerConfig {
  const host = env.OPENHARNESS_HOST ?? "127.0.0.1";
  const loopback = ["127.0.0.1", "::1", "localhost"].includes(host);
  const authMode = env.OH_AUTH_MODE === "open" ? "open" : "token";
  const accessKey = env.OH_ACCESS_KEY || undefined;
  const serverToken = env.OPENHARNESS_SERVER_TOKEN || undefined;
  const adminToken = env.OPENHARNESS_ADMIN_TOKEN || undefined;
  const oidc =
    env.OIDC_ISSUER && env.OIDC_AUDIENCE
      ? {
          issuer: env.OIDC_ISSUER,
          audience: env.OIDC_AUDIENCE,
          hs256Secret: env.OIDC_HS256_SECRET || undefined,
        }
      : undefined;

  if (!loopback && authMode !== "open" && !accessKey && !serverToken && !oidc) {
    throw new Error(
      "Refusing to listen on a non-loopback address without OPENHARNESS_SERVER_TOKEN, OIDC, OH_ACCESS_KEY, or OH_AUTH_MODE=open."
    );
  }
  if (adminToken && adminToken.length < 32) {
    throw new Error("OPENHARNESS_ADMIN_TOKEN must be at least 32 characters.");
  }
  if (env.DATABASE_URL && env.OPENHARNESS_POSTGRES !== "1") {
    throw new Error(
      "DATABASE_URL is set but postgres adapters are not enabled (see step 5)."
    );
  }

  return {
    host,
    port: Number(env.OPENHARNESS_PORT ?? 4096),
    loopback,
    authMode,
    accessKey,
    serverToken,
    adminToken,
    oidc,
    serviceTenantId: env.OPENHARNESS_SERVICE_TENANT_ID ?? "default",
    maxBodyBytes: Number(env.PROMPT_MAX_BYTES ?? 1_000_000),
    dataDir: env.OPENHARNESS_DATA_DIR ?? ".openharness",
  };
}
