import { OpenHarnessClient } from "@openharness/sdk";

/**
 * Shared OpenHarness SDK client routed through the Next.js same-origin proxy (/api/oh).
 * The proxy injects OPENHARNESS_SERVER_TOKEN and the encrypted oh_admin session cookie
 * server-side so credentials are never exposed to browser scripts.
 */
export const client = new OpenHarnessClient({ baseUrl: "/api/oh" });
