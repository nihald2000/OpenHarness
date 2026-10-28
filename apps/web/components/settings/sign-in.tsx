"use client";

import React, { useEffect, useState } from "react";
import { ArrowRight, KeyRound, Lock, ShieldCheck } from "lucide-react";
import { useAdmin } from "@/lib/use-admin";
import { Spinner } from "../ui";
import { inputCls } from "./controls";

type Providers = { google: boolean; github: boolean };
const ERROR_COPY: Record<string, string> = {
  provider_unavailable: "That sign-in provider is not configured yet.",
  session_expired: "Your session expired. Sign in again to continue.",
  oauth_setup: "OAuth is not ready. Check the web URL and server admin token configuration.",
  oauth_cancelled: "Sign-in was cancelled. You can try again whenever you’re ready.",
  oauth_invalid: "This sign-in link expired or could not be verified. Start again.",
  account_not_found: "No account is linked to that provider. Choose Create account first.",
  signup_disabled: "New accounts are restricted. Ask an administrator to add your email.",
  admin_token_invalid: "The web app’s administrator token does not match the OpenHarness server.",
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
    <main className="relative grid min-h-dvh w-full place-items-center overflow-hidden bg-bg px-4 py-10">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgba(43,85,255,0.17),transparent_55%)]" />
      <div className="relative w-full max-w-[420px]">
        <div className="mb-8 flex items-center justify-center gap-3">
          <div className="grid size-11 place-items-center rounded-2xl border border-accent/30 bg-accent/10 text-accent"><ShieldCheck className="size-5" /></div>
          <span className="text-lg font-semibold tracking-tight">OpenHarness</span>
        </div>
        <section className="rounded-3xl border border-border bg-elev/95 p-7 shadow-2xl shadow-black/30 backdrop-blur sm:p-8">
          <div className="mb-6 text-center">
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-accent">Your workspace, securely</p>
            <h1 className="text-2xl font-semibold tracking-tight">{mode === "signup" ? "Create your account" : "Welcome back"}</h1>
            <p className="mt-2 text-sm text-muted">Continue with a trusted provider to access OpenHarness.</p>
          </div>

          {expired && <p className="mb-4 rounded-xl border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">Your session expired. Sign in again to continue.</p>}
          {error && <p role="alert" className="mb-4 rounded-xl border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">{error}</p>}

          <div className="space-y-3">
            {oauthReady && providers.google && <a href={oauthUrl("google")} className="flex h-11 w-full items-center justify-center gap-3 rounded-xl border border-border bg-bg text-sm font-medium transition-colors hover:bg-hover"><span className="grid size-5 place-items-center rounded-full bg-white text-[13px] font-bold text-[#4285f4]">G</span>Continue with Google<ArrowRight className="ml-auto mr-3 size-4 text-muted" /></a>}
            {oauthReady && providers.github && <a href={oauthUrl("github")} className="flex h-11 w-full items-center justify-center gap-3 rounded-xl border border-border bg-bg text-sm font-medium transition-colors hover:bg-hover"><span className="grid size-5 place-items-center rounded-full bg-fg text-[9px] font-bold text-bg">GH</span>Continue with GitHub<ArrowRight className="ml-auto mr-3 size-4 text-muted" /></a>}
            {!oauthReady && <p className="rounded-xl border border-warning/30 bg-warning/10 px-4 py-3 text-center text-xs text-warning">Social sign-in needs the web server’s administrator token configured.</p>}
            {oauthReady && !providers.google && !providers.github && <p className="rounded-xl border border-border bg-bg px-4 py-3 text-center text-xs text-muted">Google and GitHub sign-in are not configured on this server yet.</p>}
          </div>

          <div className="my-6 flex items-center gap-3 text-[10px] uppercase tracking-widest text-muted"><span className="h-px flex-1 bg-border" />or use an admin token<span className="h-px flex-1 bg-border" /></div>
          <details className="group">
            <summary className="flex cursor-pointer list-none items-center justify-between rounded-xl border border-border px-3 py-2.5 text-xs font-medium text-fg hover:bg-hover"><span className="flex items-center gap-2"><KeyRound className="size-3.5 text-muted" />Administrator token</span><span className="text-muted transition-transform group-open:rotate-90">›</span></summary>
            <form onSubmit={handleSubmit} className="mt-3 space-y-3">
              <label htmlFor="oh-admin-token" className="block text-xs font-medium text-fg">Admin token</label>
              <input id="oh-admin-token" type="password" autoComplete="current-password" value={token} onChange={(event) => setToken(event.target.value)} placeholder="Paste the server admin token" className={`${inputCls} font-mono`} />
              <button type="submit" disabled={submitting || !token.trim()} className="flex h-10 w-full items-center justify-center gap-2 rounded-xl bg-accent px-4 text-sm font-medium text-accent-fg transition-colors hover:bg-accent-strong disabled:pointer-events-none disabled:opacity-40">{submitting ? <Spinner /> : <Lock className="size-3.5" />}Continue with token</button>
            </form>
          </details>

          <p className="mt-5 text-center text-xs text-muted">
            {mode === "login" ? "New to OpenHarness? " : "Already have an account? "}
            <button type="button" onClick={() => { setError(null); setMode(mode === "login" ? "signup" : "login"); }} disabled={mode === "login" && !signupEnabled} className="font-medium text-accent hover:underline disabled:cursor-not-allowed disabled:opacity-50">
              {mode === "login" ? (signupEnabled ? "Create an account" : "Sign-up is invite only") : "Sign in"}
            </button>
          </p>
          <p className="mt-4 text-center text-[10px] leading-relaxed text-muted">First sign-in creates your account when signup is enabled. Your provider password is never shared with OpenHarness.</p>
        </section>
        <p className="mt-5 text-center text-[10px] text-muted/80">Authentication is encrypted and kept in a secure, HTTP-only browser session.</p>
      </div>
    </main>
  );
}
