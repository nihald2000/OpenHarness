import http from "node:http";
import type { KeepaliveHandle } from "./worker/launcher.ts";

/**
 * Keeps the Modal `@modal.web_server` container alive while background agent runs execute
 * by holding a loopback HTTP connection to `GET /v1/internal/hold` until `task()` settles.
 */
export function createKeepalive(getPort: () => number, enabled = Boolean(process.env.MODAL_ENVIRONMENT || process.env.OH_MODAL_KEEPALIVE === "1")): KeepaliveHandle {
  return {
    async hold<T>(runId: string, task: () => Promise<T>): Promise<T> {
      if (!enabled) {
        return task();
      }
      const port = getPort();
      let req: http.ClientRequest | undefined;
      try {
        req = http.get(`http://127.0.0.1:${port}/v1/internal/hold?runId=${encodeURIComponent(runId)}`);
        req.on("error", () => {});
      } catch {
        // ignore loopback hold error
      }
      try {
        return await task();
      } finally {
        try {
          req?.destroy();
        } catch {}
      }
    },
  };
}
