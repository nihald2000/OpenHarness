import React, { useEffect } from "react";
import { usePathname, useRouter } from "@/lib/router";
import { AppProvider } from "@/lib/app-context";
import { useAdmin } from "@/lib/use-admin";
import { Sidebar } from "./sidebar";
import { Toasts } from "./toast";

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
        className="grid min-h-dvh w-full place-items-center text-sm text-muted"
        role="status"
      >
        Checking your session...
      </main>
    );
  }
  if (!admin && !authDisabled) {
    return (
      <main
        className="grid min-h-dvh w-full place-items-center text-sm text-muted"
        role="status"
      >
        Redirecting to sign in...
      </main>
    );
  }

  return (
    <AppProvider>
      <a
        href="#oh-composer"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-lg focus:bg-accent focus:px-3 focus:py-1.5 focus:text-xs focus:font-medium focus:text-accent-fg"
      >
        Skip to message input
      </a>
      <div className="flex h-dvh overflow-hidden">
        <Sidebar />
        <main className="flex min-w-0 flex-1">{children}</main>
      </div>
      <Toasts />
    </AppProvider>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  return <AuthGate>{children}</AuthGate>;
}
