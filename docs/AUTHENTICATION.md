# Web sign-in and account creation

The web app supports passwordless Google and GitHub OAuth. The first successful `Create account` flow stores a local account profile; later sign-ins resolve the same provider identity. A verified matching email can link Google and GitHub identities to one profile. Provider access tokens are used only to fetch identity data and are never stored.

## Provider setup

Set `OPENHARNESS_WEB_URL` to the browser-visible origin, `OPENHARNESS_ADMIN_TOKEN` to the same administrator token used by the OpenHarness server, and a stable `OPENHARNESS_WEB_SESSION_SECRET` in production. Register these exact callback URLs with the providers:

```text
http://localhost:3000/api/auth/google/callback
http://localhost:3000/api/auth/github/callback
```

Replace the origin with the production HTTPS origin in managed deployments. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` for Google, and `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` for GitHub. Google requests `openid email profile`; GitHub requests `read:user user:email` so the app can require a verified primary email.

Google identity tokens have their signature, issuer, audience, expiry, and nonce checked against Google's published signing keys. Both providers use state and PKCE. Callback errors, denied consent, expired state, missing verified email, provider outages, unknown providers, and invalid server administrator credentials return to `/login` with a user-safe error.

## Signup policy and account storage

New account creation is disabled by default. Set `OPENHARNESS_AUTH_ALLOWED_EMAILS` to a comma-separated invite list, or set `OPENHARNESS_AUTH_ALLOW_SIGNUP=true` to allow any Google/GitHub account with a verified email. A non-empty allowlist remains restrictive even when open signup is enabled. Login mode never creates a missing account; users can choose `Create account` when signup policy allows it.

Profiles and linked provider subject IDs are stored in `web-users.json` under `OPENHARNESS_AUTH_DATA_DIR` (Compose mounts the persistent `/data` volume). Only identity/profile fields are stored. The session is encrypted in an HTTP-only, secure-in-production cookie and expires after eight hours. Logout clears the session cookie. The OAuth state/PKCE cookie expires after ten minutes.

This release still has one shared OpenHarness workspace and administrator token. Every accepted OAuth account receives that same workspace access; OAuth accounts are not isolated tenants and do not have separate chat histories or roles. Keep signup invite-only for private deployments. Do not expose open signup on a public installation until per-user authorization and data isolation are implemented. The legacy administrator token sign-in remains available for recovery.

The web proxy now requires a valid session cookie for every `/v1/**` request; `/health` remains public. Configure the same `OPENHARNESS_ADMIN_TOKEN` in the web and server services so OAuth sessions can be verified upstream.
