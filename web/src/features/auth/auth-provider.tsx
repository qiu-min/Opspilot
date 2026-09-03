import { createContext, useContext, useState, type ReactNode } from "react";
import type { AuthSession } from "./auth-session";

export type AuthContextValue = {
  session: AuthSession | null;
  setSession: (session: AuthSession) => void;
  clearSession: () => void;
};

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<AuthSession | null>(null);

  const clearSession = () => {
    setSession(null);
  };

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
