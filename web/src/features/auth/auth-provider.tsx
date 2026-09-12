import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import {
  clearStoredAuthSession,
  isAuthSessionExpired,
  loadStoredAuthSession,
  saveAuthSession,
  type AuthSession,
} from "./auth-session";

export type AuthContextValue = {
  session: AuthSession | null;
  setSession: (session: AuthSession) => void;
  clearSession: () => void;
};

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSessionState] = useState<AuthSession | null>(() => loadStoredAuthSession());

  const setSession = useCallback((nextSession: AuthSession) => {
    if (isAuthSessionExpired(nextSession)) {
      clearStoredAuthSession();
      setSessionState(null);
      return;
    }

    saveAuthSession(nextSession);
    setSessionState(nextSession);
  }, []);

  const clearSession = useCallback(() => {
    clearStoredAuthSession();
    setSessionState(null);
  }, []);

  useEffect(() => {
    if (session === null) return;

    const expiresAt = Date.parse(session.expiresAtUtc);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      clearStoredAuthSession();
      setSessionState(null);
      return;
    }

    const timer = setTimeout(() => {
      clearStoredAuthSession();
      setSessionState(null);
    }, expiresAt - Date.now());
    return () => clearTimeout(timer);
  }, [session]);

  return (
    <AuthContext.Provider value={{ session, setSession, clearSession }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const authContext = useContext(AuthContext);

  if (authContext === undefined) {
    throw new Error("useAuth must be used within AuthProvider");
  }

  return authContext;
}
