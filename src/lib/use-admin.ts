import { useState, useEffect, useCallback } from "react";

export interface AuthenticatedUser {
  id: string;
  name: string;
  email: string;
}

const STORAGE_KEY_AUTH = "oh_admin_authenticated";

export function useAdmin() {
  const [admin, setAdmin] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY_AUTH);
      return saved === null ? true : saved === "true"; // Default to open in local mode
    } catch {
      return true;
    }
  });

  const [loading, setLoading] = useState(false);
  const [expired, setExpired] = useState(false);
  const [user, setUser] = useState<AuthenticatedUser | null>({
    id: "usr_admin",
    name: "Admin User",
    email: "admin@openharness.local",
  });
  const [authDisabled] = useState(true);

  const login = useCallback(async (token: string): Promise<{ ok: true } | { ok: false; error: string }> => {
    if (!token.trim()) {
      return { ok: false, error: "Please enter an administrator token." };
    }
    try {
      localStorage.setItem(STORAGE_KEY_AUTH, "true");
      setAdmin(true);
      setExpired(false);
      return { ok: true };
    } catch {
      return { ok: false, error: "Storage error occurred." };
    }
  }, []);

  const logout = useCallback(async (): Promise<void> => {
    try {
      localStorage.setItem(STORAGE_KEY_AUTH, "false");
      setAdmin(false);
      setUser(null);
    } catch {
      // ignore
    }
  }, []);

  const markSignedOut = useCallback((isExpired = true) => {
    setAdmin(false);
    setExpired(isExpired);
  }, []);

  const refresh = useCallback(async (): Promise<boolean> => {
    return admin;
  }, [admin]);

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
