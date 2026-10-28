"use client";

import { useEffect, useSyncExternalStore } from "react";
import type { AuthenticatedUser } from "./admin-session";

export interface AdminSnapshot {
  admin: boolean;
  loading: boolean;
  expired: boolean;
  user: AuthenticatedUser | null;
}

let state: AdminSnapshot = {
  admin: false,
  loading: true,
  expired: false,
  user: null,
};

const SERVER_SNAPSHOT: AdminSnapshot = {
  admin: false,
  loading: true,
  expired: false,
  user: null,
};

let initialized = false;
let inFlight: Promise<boolean> | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) {
    listener();
  }
}

function setState(next: Partial<AdminSnapshot>): void {
  state = { ...state, ...next };
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): AdminSnapshot {
  return state;
}

function getServerSnapshot(): AdminSnapshot {
  return SERVER_SNAPSHOT;
}

export function refreshAdmin(): Promise<boolean> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const res = await fetch("/api/admin/session", {
        method: "GET",
        cache: "no-store",
      });
      if (!res.ok) {
        setState({ admin: false, loading: false, user: null });
        return false;
      }
      const data = (await res.json()) as { admin?: boolean; user?: AuthenticatedUser | null };
      const isAdmin = Boolean(data.admin);
      setState({
        admin: isAdmin,
        loading: false,
        user: isAdmin ? data.user ?? null : null,
        expired: isAdmin ? false : state.expired,
      });
      return isAdmin;
    } catch {
      setState({ admin: false, loading: false, user: null });
      return false;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

export function markSignedOut(expired = true): void {
  setState({ admin: false, loading: false, expired, user: null });
}

export async function adminLogin(
  token: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await fetch("/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try {
        const body = (await res.json()) as { error?: string };
        if (body.error) msg = body.error;
      } catch {
        // ignore JSON parse failure
      }
      return { ok: false, error: msg };
    }
    setState({ admin: true, loading: false, expired: false, user: null });
    return { ok: true };
  } catch {
    return { ok: false, error: "Could not reach the web server" };
  }
}

export async function adminLogout(): Promise<void> {
  try {
    await fetch("/api/admin/logout", { method: "POST" });
  } catch {
    // ignore network errors on logout
  }
  setState({ admin: false, loading: false, expired: false, user: null });
}

export function useAdmin() {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  useEffect(() => {
    if (!initialized) {
      initialized = true;
      void refreshAdmin();
    }
  }, []);

  return {
    admin: snapshot.admin,
    loading: snapshot.loading,
    expired: snapshot.expired,
    user: snapshot.user,
    refresh: refreshAdmin,
    login: adminLogin,
    logout: adminLogout,
    markSignedOut,
  };
}
