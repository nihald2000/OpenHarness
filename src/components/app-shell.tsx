import React, { useEffect } from "react";
import { usePathname, useRouter } from "@/lib/router";
import { AppProvider } from "@/lib/app-context";
import { isDemoMode } from "@/lib/client";
import { useAdmin } from "@/lib/use-admin";
import { Sidebar } from "./sidebar";
import { Toasts } from "./toast";
import { BrandLogo, Spinner } from "./ui";

function AuthGate({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { admin, loading, expired, authDisabled } = useAdmin();

  useEffect(() => {
    if (!authDisabled && !loading && !admin && pathname !== "/login") {
      router.replace(
        `/login?returnTo=${encodeURIComponent(pathname || "/")}${
          expired ? "&error=session_expired" : ""
        }`
      );
    }
  }, [admin, authDisabled, expired, loading, pathname, router]);

  if (pathname === "/login") return <>{children}</>;
  if (loading) {
    return (
      <main
        className="grid min-h-dvh w-full place-items-center bg-bg p-6"
        role="status"
      >
        <div className="flex flex-col items-center gap-3 text-center animate-fade-in">
          <BrandLogo className="size-8" />
          <div className="inline-flex items-center gap-2 text-sm text-muted">
            <Spinner className="size-4 text-muted" />
            <span>Checking your session...</span>
          </div>
        </div>
      </main>
    );
  }
  if (!admin && !authDisabled) {
    return (
      <main
        className="grid min-h-dvh w-full place-items-center bg-bg p-6"
        role="status"
      >
        <div className="flex flex-col items-center gap-3 text-center animate-fade-in">
          <BrandLogo className="size-8" />
          <div className="inline-flex items-center gap-2 text-sm text-muted">
            <Spinner className="size-4 text-muted" />
            <span>Redirecting to sign in...</span>
          </div>
        </div>
      </main>
    );
  }

  return (
    <AppProvider>
      {isDemoMode && (
        <div
          role="region"
          aria-label="Demo mode notice"
          className="bg-amber-500/15 border-b border-amber-500/30 px-3 py-1 text-center text-xs font-medium text-amber-300"
        >
          Demo mode - no real agent
        </div>
      )}
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
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  return <AuthGate>{children}</AuthGate>;
}
