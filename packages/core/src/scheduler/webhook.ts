import crypto from "node:crypto";
import { ScheduleManager } from "./index.ts";
export { ScheduleManager };

export function verifyWebhookSignature(
  payload: string,
  secret: string,
  signatureHex: string
): boolean {
  const expected = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  if (expected.length !== signatureHex.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHex));
}
