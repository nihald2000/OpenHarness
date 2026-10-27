"use client";

import React, { useState } from "react";
import { KeyRound, Lock } from "lucide-react";
import { useAdmin } from "@/lib/use-admin";
import { Spinner } from "../ui";
import { Callout, inputCls } from "./controls";

export function SignInCard({ expired }: { expired?: boolean }) {
  const { login } = useAdmin();
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const value = token;
    setToken("");
    setSubmitting(true);
    const res = await login(value);
    setSubmitting(false);
    if (!res.ok) {
      setError(res.error);
    }
  };

  return (
    <div className="mx-auto my-12 w-full max-w-md px-4">
      {expired && (
        <div className="mb-4">
          <Callout tone="warning">
            Your admin session ended. Sign in again to continue.
          </Callout>
        </div>
      )}

      <div className="rounded-2xl border border-border bg-elev p-6 shadow-xl shadow-black/25">
        <div className="mb-4 flex items-center gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-accent/35 bg-accent/10 text-accent">
            <KeyRound className="size-5" aria-hidden="true" />
          </div>
          <div>
            <h1 className="text-sm font-semibold text-fg">
              Administrator sign-in
            </h1>
            <p className="text-xs text-muted">
              Settings are only available to administrators.
            </p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label
              htmlFor="oh-admin-token"
              className="mb-1 block text-xs font-medium text-fg"
            >
              Admin token
            </label>
            <input
              id="oh-admin-token"
              type="password"
              autoFocus
              autoComplete="current-password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="oh_admin_..."
              className={`${inputCls} font-mono`}
            />
            <p className="mt-1 text-[11px] text-muted">
              Run <code className="font-mono">bun run oh admin token</code> on
              the server to get it.
            </p>
          </div>

          {error && (
            <p role="alert" className="text-xs text-danger">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={submitting || !token.trim()}
            className="flex h-9 w-full items-center justify-center gap-2 rounded-xl bg-accent px-4 text-xs font-medium text-accent-fg transition-colors hover:bg-accent-strong disabled:pointer-events-none disabled:opacity-40"
          >
            {submitting ? (
              <Spinner />
            ) : (
              <Lock className="size-3.5" aria-hidden="true" />
            )}
            <span>Sign in</span>
          </button>
        </form>

        <p className="mt-4 text-[11px] leading-relaxed text-muted">
          The token is kept in an encrypted, httpOnly session cookie for 8 hours
          - page scripts can never read it.
        </p>
      </div>
    </div>
  );
}
