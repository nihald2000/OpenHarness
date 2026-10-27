"use client";

import React from "react";
import { AppProvider } from "@/lib/app-context";
import { Sidebar } from "./sidebar";
import { Toasts } from "./toast";

export function AppShell({ children }: { children: React.ReactNode }) {
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
