import React, { useEffect, useState } from "react";
import { usePathname } from "@/lib/router";
import { AppProvider } from "@/lib/app-context";
import { client } from "@/lib/client";
import { Sidebar } from "./sidebar";
import { Toasts } from "./toast";
import { BrandLogo, Spinner } from "./ui";

function GuestSessionBootstrap({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    setReady(false);
    setError(null);
    void client
      .bootstrapGuestSession()
      .then(() => {
        if (active) setReady(true);
      })
      .catch((err: unknown) => {
        if (active) {
          setError(err instanceof Error ? err.message : "Could not connect to OpenHarness.");
        }
      });
    return () => {
      active = false;
    };
  }, [attempt]);

  if (error) {
    return (
      <main className="grid min-h-dvh w-full place-items-center bg-bg p-6">
        <section className="w-full max-w-sm rounded-2xl border border-border bg-elev p-6 text-center shadow-card">
          <BrandLogo className="mx-auto mb-4 size-8" />
          <h1 className="text-base font-semibold text-fg">OpenHarness is unavailable</h1>
          <p className="mt-2 text-sm text-muted">{error}</p>
          <button
            type="button"
            onClick={() => setAttempt((value) => value + 1)}
            className="mt-5 rounded-xl bg-accent px-4 py-2 text-sm font-medium text-accent-fg hover:bg-accent-strong"
          >
            Retry
          </button>
        </section>
      </main>
    );
  }

  if (!ready) {
    return (
      <main className="grid min-h-dvh w-full place-items-center bg-bg p-6" role="status">
        <div className="flex flex-col items-center gap-3 text-center">
          <BrandLogo className="size-8" />
          <div className="inline-flex items-center gap-2 text-sm text-muted">
            <Spinner className="size-4 text-muted" />
            <span>Opening your workspace...</span>
          </div>
        </div>
      </main>
    );
  }

  return <>{children}</>;
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const signInRoute = pathname === "/login";

  return (
    <GuestSessionBootstrap>
      {signInRoute ? (
        children
      ) : (
        <AppProvider>
          <a
            href="#oh-composer"
            className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-lg focus:bg-accent focus:px-3 focus:py-2 focus:text-xs focus:font-medium focus:text-accent-fg"
          >
            Skip to message input
          </a>
          <div className="flex h-dvh overflow-hidden bg-bg text-fg">
            <Sidebar />
            <main className="flex min-w-0 flex-1 bg-bg">{children}</main>
          </div>
          <Toasts />
        </AppProvider>
      )}
    </GuestSessionBootstrap>
  );
}
