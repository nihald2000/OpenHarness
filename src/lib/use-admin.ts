import { useState, useEffect, useCallback } from "react";
import { isDemoMode } from "./client";

export interface AuthenticatedUser {
  id: string;
  name: string;
  email: string;
}

export interface AdminLoginResult {
  ok: boolean;
  error?: string;
}

export async function loginAdminWithToken(
  token: string,
  baseUrl = "",
  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis)
): Promise<AdminLoginResult> {
  if (!token.trim()) {
    return { ok: false, error: "Please enter an administrator token." };
  }
  try {
    const res = await fetchImpl(`${baseUrl}/v1/admin/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ token: token.trim() }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      return { ok: false, error: body.error ?? `HTTP ${res.status}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export function useAdmin() {
  const [admin, setAdmin] = useState<boolean>(isDemoMode);
  const [loading, setLoading] = useState<boolean>(!isDemoMode);
  const [expired, setExpired] = useState(false);
  const [user, setUser] = useState<AuthenticatedUser | null>(
    isDemoMode
      ? {
          id: "usr_demo",
          name: "Demo User",
          email: "demo@openharness.local",
        }
      : null
  );
  const [authDisabled, setAuthDisabled] = useState<boolean>(true);

  const refresh = useCallback(async (): Promise<boolean> => {
    if (isDemoMode) {
      setAdmin(true);
      setLoading(false);
      return true;
    }
    try {
      const res = await fetch("/v1/admin/session", { credentials: "include" });
      if (!res.ok) {
        setAdmin(false);
        setLoading(false);
        return false;
      }
      const data = (await res.json()) as {
        admin?: boolean;
        authDisabled?: boolean;
        user?: AuthenticatedUser | null;
      };
      const isAdmin = Boolean(data.admin);
      setAdmin(isAdmin);
      setAuthDisabled(data.authDisabled ?? true);
      setUser(data.user ?? null);
      setLoading(false);
      return isAdmin;
    } catch {
      setAdmin(false);
      setLoading(false);
      return false;
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const login = useCallback(
    async (token: string): Promise<{ ok: true } | { ok: false; error: string }> => {
      const result = await loginAdminWithToken(token);
      if (!result.ok) {
        setAdmin(false);
        return { ok: false, error: result.error ?? "Invalid administrator token." };
      }
      setAdmin(true);
      setExpired(false);
      setUser({
        id: "usr_admin",
        name: "Admin User",
        email: "admin@openharness.local",
      });
      return { ok: true };
    },
    []
  );

  const logout = useCallback(async (): Promise<void> => {
    try {
      await fetch("/v1/admin/session", {
        method: "DELETE",
        credentials: "include",
      });
    } catch {
      // ignore network error on logout
    }
    setAdmin(false);
    setUser(null);
  }, []);

  const markSignedOut = useCallback((isExpired = true) => {
    setAdmin(false);
    setExpired(isExpired);
  }, []);

  return {
    admin,
    authDisabled,
    loading,
    expired,
    user,
    refresh,
    login,
    logout,
    markSignedOut,
  };
}
