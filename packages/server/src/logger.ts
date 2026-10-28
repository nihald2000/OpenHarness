const SECRET_KEY = /(?:secret|token|authorization|password|credential|api[_-]?key)/i;
const CREDENTIAL_TEXT = /\b(Bearer\s+)[A-Za-z0-9._~+\/-]+=*|\b(sk-[A-Za-z0-9_-]{8,})\b|\b((?:api[_-]?key|access[_-]?token|secret)\s*[:=]\s*)["']?[^\s"',;}]+/gi;

export function redactLogData(value: unknown, key = ""): unknown {
  if (SECRET_KEY.test(key)) return "[REDACTED]";
  if (typeof value === "string") return value.replace(CREDENTIAL_TEXT, (_match, bearerPrefix?: string, apiToken?: string, keyPrefix?: string) => `${bearerPrefix ?? keyPrefix ?? ""}[REDACTED]${apiToken ? "" : ""}`);
  if (Array.isArray(value)) return value.map((item) => redactLogData(item));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, redactLogData(child, childKey)]));
  if (typeof value === "bigint") return value.toString();
  return value;
}

export function logError(event: string, error: unknown, context: Record<string, unknown> = {}) {
  const message = error instanceof Error ? error.message : String(error);
  const record = redactLogData({ time: new Date().toISOString(), level: "error", event, message, ...context });
  console.error(JSON.stringify(record));
}
