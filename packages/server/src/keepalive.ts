import crypto from "node:crypto";
import type { KeepaliveHandle } from "./worker/launcher.ts";

export const INTERNAL_HOLD_KEY = crypto.randomBytes(32).toString("hex");

/** Keep the Modal web worker active through public ingress during background runs. */
export function createKeepalive(
  getPort: () => number,
  enabled = Boolean(process.env.MODAL_ENVIRONMENT || process.env.OH_MODAL_KEEPALIVE === "1"),
): KeepaliveHandle {
  return {
    async hold<T>(runId: string, task: () => Promise<T>): Promise<T> {
      if (!enabled) return task();
      const base = (process.env.OH_PUBLIC_URL || `http://127.0.0.1:${getPort()}`).replace(/\/$/, "");
      let stopped = false;
      let current: AbortController | undefined;
      const loop = (async () => {
        while (!stopped) {
          current = new AbortController();
          try {
            const response = await fetch(`${base}/v1/internal/hold?secs=100&runId=${encodeURIComponent(runId)}`, {
              headers: { "x-oh-internal": INTERNAL_HOLD_KEY },
              signal: current.signal,
            });
            await response.text();
          } catch {
            if (!stopped) await new Promise((resolve) => setTimeout(resolve, 2_000));
          }
        }
      })();
      try {
        return await task();
      } finally {
        stopped = true;
        current?.abort();
        await loop.catch(() => {});
      }
    },
  };
}
