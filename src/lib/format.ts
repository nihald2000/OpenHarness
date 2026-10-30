import { ACTIVE_RUN_STATUSES, OpenHarnessError, type RunStatus } from "@/types/sdk";

export function isActive(status?: RunStatus | null): boolean {
  if (!status) return false;
  return (ACTIVE_RUN_STATUSES as readonly string[]).includes(status);
}

export function activityLabel(status?: RunStatus | null): string {
  switch (status) {
    case "awaiting_permission":
      return "Waiting for your approval";
    case "queued":
      return "Queued";
    case "verifying":
      return "Verifying";
    case "running":
      return "Working";
    default:
      return "The agent is still working on this session, wait or press Stop.";
  }
}

export function isStatus(err: unknown, status: number): boolean {
  return err instanceof OpenHarnessError && err.status === status;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return String(err);
}

const rtf =
  typeof Intl !== "undefined" && typeof Intl.RelativeTimeFormat !== "undefined"
    ? new Intl.RelativeTimeFormat("en", { style: "short", numeric: "always" })
    : null;

export function relativeTime(ts: number | string, now = Date.now()): string {
  const time = typeof ts === "string" ? new Date(ts).getTime() : ts;
  if (!Number.isFinite(time)) return "";
  const diffSec = Math.round((time - now) / 1000);
  const absSec = Math.abs(diffSec);
  if (absSec < 45) return "just now";
  const sign = diffSec <= 0 ? -1 : 1;
  const absMin = Math.round(absSec / 60);
  if (absMin < 60) {
    return rtf ? rtf.format(sign * absMin, "minute") : `${absMin}m ago`;
  }
  const absHr = Math.round(absSec / 3600);
  if (absHr < 24) {
    return rtf ? rtf.format(sign * absHr, "hour") : `${absHr}h ago`;
  }
  const absDay = Math.round(absSec / 86400);
  if (absDay < 7) {
    return rtf ? rtf.format(sign * absDay, "day") : `${absDay}d ago`;
  }
  return new Date(time).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

export function formatTokens(n?: number | null): string {
  if (!n || !Number.isFinite(n) || n <= 0) return "0";
  if (n < 1000) return Math.round(n).toString();
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function totalTokens(usage?: {
  input?: number;
  output?: number;
  reasoning?: number;
  cacheRead?: number;
} | null): number {
  if (!usage) return 0;
  return (usage.input ?? 0) + (usage.output ?? 0) + (usage.reasoning ?? 0);
}

export function formatCost(cost?: number | null): string {
  if (!cost || !Number.isFinite(cost) || cost <= 0) return "$0.00";
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}

export function formatDuration(ms?: number | null): string {
  if (ms === undefined || ms === null || !Number.isFinite(ms) || ms < 0) return "";
  if (ms < 60_000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  const mins = Math.floor(ms / 60_000);
  const secs = Math.round((ms % 60_000) / 1000);
  return `${mins}m ${secs}s`;
}

export function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function csv(parts: Array<string | undefined | null | false>): string {
  return parts.filter(Boolean).join(", ");
}
