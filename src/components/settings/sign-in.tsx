import React, { useEffect, useState } from "react";
import { ArrowRight, ChevronRight, KeyRound, Lock } from "lucide-react";
import { useAdmin } from "@/lib/use-admin";
import { BrandLogo, Spinner } from "../ui";
import { inputCls } from "./controls";

type Providers = { google: boolean; github: boolean };
const ERROR_COPY: Record<string, string> = {
  provider_unavailable: "That sign-in provider is not configured yet.",
  session_expired: "Your session expired. Sign in again to continue.",
  oauth_setup: "OAuth is not ready. Check the web URL and server admin token configuration.",
  oauth_cancelled: "Sign-in was cancelled. You can try again whenever you're ready.",
  oauth_invalid: "This sign-in link expired or could not be verified. Start again.",
  account_not_found: "No account is linked to that provider. Choose Create account first.",
  signup_disabled: "New accounts are restricted. Ask an administrator to add your email.",
  admin_token_invalid: "The web app's administrator token does not match the OpenHarness server.",
  oauth_failed: "Sign-in could not be completed. Please try again.",
};

export function SignInCard({ expired, returnTo = "/settings", initialError }: { expired?: boolean; returnTo?: string; initialError?: string }) {
  const { login, admin } = useAdmin();
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(initialError ? ERROR_COPY[initialError] ?? ERROR_COPY.oauth_failed! : null);
  const [submitting, setSubmitting] = useState(false);
  const [providers, setProviders] = useState<Providers>({ google: false, github: false });
  const [oauthReady, setOauthReady] = useState(true);
  const [signupEnabled, setSignupEnabled] = useState(false);
  const [mode, setMode] = useState<"login" | "signup">("login");

  useEffect(() => {
    let active = true;
    void fetch("/api/auth/providers", { cache: "no-store" }).then(async (response) => {
      if (!response.ok) return;
      const data = await response.json() as { providers?: Providers; signupEnabled?: boolean; adminTokenConfigured?: boolean };
      if (active) { setProviders(data.providers ?? { google: false, github: false }); setSignupEnabled(data.signupEnabled === true); setOauthReady(data.adminTokenConfigured === true); }
    }).catch(() => undefined);
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (admin && window.location.pathname === "/login") window.location.replace(returnTo);
  }, [admin, returnTo]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault(); setError(null); const value = token; setToken(""); setSubmitting(true);
    const result = await login(value); setSubmitting(false);
    if (!result.ok) setError(result.error);
    else if (window.location.pathname === "/login") window.location.assign(returnTo);
  };

  const oauthUrl = (provider: "google" | "github") => `/api/auth/${provider}?mode=${mode}&returnTo=${encodeURIComponent(returnTo)}`;

  return (
    <main className="grid min-h-dvh w-full place-items-center bg-bg px-4 py-10">
      <div className="w-full max-w-[420px] animate-fade-in">
        <div className="mb-6 flex items-center justify-center gap-2">
          <BrandLogo className="size-8" />
          <span className="text-lg font-semibold tracking-tight text-fg">OpenHarness</span>
        </div>

        <section className="rounded-2xl border border-border bg-elev p-6 shadow-card sm:p-8">
          <div className="mb-6 text-center">
            <p className="mb-1 text-xs font-medium text-accent">Your workspace, securely</p>
            <h1 className="text-xl font-semibold tracking-tight text-fg">
              {mode === "signup" ? "Create your account" : "Welcome back"}
            </h1>
            <p className="mt-1 text-sm text-muted">
              Continue with a trusted provider to access OpenHarness.
            </p>
          </div>

          {expired && (
            <p className="mb-4 rounded-xl border border-warning/35 bg-warning/10 px-3 py-2 text-xs text-warning">
              Your session expired. Sign in again to continue.
            </p>
          )}
          {error && (
            <p
              role="alert"
              className="mb-4 rounded-xl border border-danger/35 bg-danger/10 px-3 py-2 text-xs text-danger"
            >
              {error}
            </p>
          )}

          <div className="space-y-2">
            {oauthReady && providers.google && (
              <a
                href={oauthUrl("google")}
                className="flex h-10 w-full items-center justify-between rounded-xl border border-border bg-bg px-4 text-sm font-medium text-fg transition-colors duration-150 ease-out hover:bg-hover"
              >
                <span className="inline-flex items-center gap-3">
                  <span className="grid size-5 place-items-center rounded-full border border-border bg-elev text-xs font-semibold text-accent">
                    G
                  </span>
                  <span>Continue with Google</span>
                </span>
                <ArrowRight className="size-4 text-muted" aria-hidden="true" />
              </a>
            )}
            {oauthReady && providers.github && (
              <a
                href={oauthUrl("github")}
                className="flex h-10 w-full items-center justify-between rounded-xl border border-border bg-bg px-4 text-sm font-medium text-fg transition-colors duration-150 ease-out hover:bg-hover"
              >
                <span className="inline-flex items-center gap-3">
                  <span className="grid size-5 place-items-center rounded-full bg-fg text-xs font-semibold text-bg">
                    GH
                  </span>
                  <span>Continue with GitHub</span>
                </span>
                <ArrowRight className="size-4 text-muted" aria-hidden="true" />
              </a>
            )}
            {!oauthReady && (
              <p className="rounded-xl border border-warning/35 bg-warning/10 px-4 py-3 text-center text-xs text-warning">
                Social sign-in needs the web server's administrator token configured.
              </p>
            )}
            {oauthReady && !providers.google && !providers.github && (
              <p className="rounded-xl border border-border bg-bg px-4 py-3 text-center text-xs text-muted">
                Google and GitHub sign-in are not configured on this server yet.
              </p>
            )}
          </div>

          <div className="my-6 flex items-center gap-3 text-xs text-muted">
            <span className="h-px flex-1 bg-border" />
            <span>or use an admin token</span>
            <span className="h-px flex-1 bg-border" />
          </div>

          <details className="group">
            <summary className="touch-target flex cursor-pointer list-none items-center justify-between rounded-xl border border-border bg-bg px-3 py-2 text-xs font-medium text-fg transition-colors duration-150 ease-out hover:bg-hover">
              <span className="flex items-center gap-2">
                <KeyRound className="size-3.5 text-muted" aria-hidden="true" />
                <span>Administrator token</span>
              </span>
              <ChevronRight
                className="size-3.5 text-muted transition-transform duration-150 ease-out group-open:rotate-90"
                aria-hidden="true"
              />
            </summary>
            <form onSubmit={handleSubmit} className="mt-3 space-y-3">
              <label htmlFor="oh-admin-token" className="block text-xs font-medium text-fg">
                Admin token
              </label>
              <input
                id="oh-admin-token"
                type="password"
                autoComplete="current-password"
                value={token}
                onChange={(event) => setToken(event.target.value)}
                placeholder="Paste the server admin token"
                className={`${inputCls} font-mono`}
              />
              <button
                type="submit"
                disabled={submitting || !token.trim()}
                className="touch-target flex h-10 w-full items-center justify-center gap-2 rounded-xl bg-accent px-4 text-sm font-medium text-accent-fg transition-colors duration-150 ease-out hover:bg-accent-strong disabled:pointer-events-none disabled:opacity-40"
              >
                {submitting ? <Spinner /> : <Lock className="size-3.5" aria-hidden="true" />}
                <span>Continue with token</span>
              </button>
            </form>
          </details>

          <p className="mt-5 text-center text-xs text-muted">
            {mode === "login" ? "New to OpenHarness? " : "Already have an account? "}
            <button
              type="button"
              onClick={() => {
                setError(null);
                setMode(mode === "login" ? "signup" : "login");
              }}
              disabled={mode === "login" && !signupEnabled}
              className="touch-target font-medium text-accent hover:underline disabled:cursor-not-allowed disabled:opacity-50"
            >
              {mode === "login"
                ? signupEnabled
                  ? "Create an account"
                  : "Sign-up is invite only"
                : "Sign in"}
            </button>
          </p>
          <p className="mt-3 text-center text-xs leading-normal text-muted">
            First sign-in creates your account when signup is enabled. Your provider password is never shared with OpenHarness.
          </p>
        </section>

        <p className="mt-4 text-center text-xs text-muted">
          Authentication is encrypted and kept in a secure, HTTP-only browser session.
        </p>
      </div>
    </main>
  );
}
