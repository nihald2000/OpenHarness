export interface LoadedServerConfig {
  host: string;
  port: number;
  loopback: boolean;
  authMode?: "open" | "token";
  accessKey?: string;
  serverToken?: string;
  adminToken?: string;
  oidc?: { issuer: string; audience: string; hs256Secret: string };
  serviceTenantId: string;
  maxBodyBytes: number;
  dataDir: string;
  workspaceRoot?: string;
  isolateSessions?: boolean;
  defaultModel?: string;
  defaultBaseUrl?: string;
}

export function loadServerConfig(env: NodeJS.ProcessEnv = process.env): LoadedServerConfig {
  const host = env.OPENHARNESS_HOST ?? "127.0.0.1";
  const loopback = ["127.0.0.1", "::1", "localhost"].includes(host);
  const authMode = env.OH_AUTH_MODE === "open" ? "open" : "token";
  const accessKey = env.OH_ACCESS_KEY || undefined;
  const serverToken = env.OPENHARNESS_SERVER_TOKEN || undefined;
  const adminToken = env.OPENHARNESS_ADMIN_TOKEN || undefined;
  const hasMetaApiKey = Boolean(env.MODEL_API_KEY || env.META_API_KEY);
  if ((env.OIDC_ISSUER || env.OIDC_AUDIENCE) && (!env.OIDC_HS256_SECRET || env.OIDC_HS256_SECRET.length < 32)) {
    throw new Error(
      "OIDC_HS256_SECRET (at least 32 characters) is required when OIDC_ISSUER or OIDC_AUDIENCE is configured."
    );
  }
  const oidc =
    env.OIDC_ISSUER && env.OIDC_AUDIENCE && env.OIDC_HS256_SECRET
      ? {
          issuer: env.OIDC_ISSUER,
          audience: env.OIDC_AUDIENCE,
          hs256Secret: env.OIDC_HS256_SECRET,
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
    workspaceRoot: env.OPENHARNESS_WORKSPACE_ROOT || undefined,
    isolateSessions:
      env.OPENHARNESS_ISOLATE_SESSIONS === "1" ||
      env.OPENHARNESS_WEB_GUEST === "1" ||
      Boolean(env.MODAL_ENVIRONMENT),
    defaultModel: env.OPENHARNESS_MODEL ?? (hasMetaApiKey ? "muse-spark-1.3" : undefined),
    defaultBaseUrl: env.OPENHARNESS_BASE_URL ?? (hasMetaApiKey ? "https://api.meta.ai/v1" : undefined),
  };
}
