/**
 * Temporary demo mode: skips the sign-in screen and the proxy's admin-cookie gate.
 * This is intentionally server-side only and must never be enabled on a deployment
 * that exposes an administrative backend to untrusted visitors.
 */
export function authDisabled(): boolean {
  return process.env.OPENHARNESS_WEB_AUTH_DISABLED === "true";
}
