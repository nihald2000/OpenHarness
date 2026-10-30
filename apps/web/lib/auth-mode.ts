/**
 * Local development stays easy to use. Production still requires an
 * authenticated session unless the explicit override is enabled.
 */
export function authDisabled(): boolean {
  if (process.env.OPENHARNESS_WEB_AUTH_DISABLED === "true") return true;
  return process.env.NODE_ENV !== "production" && !process.env.OIDC_ISSUER?.trim();
}
