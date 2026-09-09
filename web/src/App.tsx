import { SessionPage } from "./features/session/session-page";
import { useAuth } from "./features/auth/auth-provider";
import { LoginPage } from "./features/auth/login-page";
import { RegisterPage } from "./features/auth/register-page";
import { useState } from "react";

type AuthView = "login" | "register";

export default function App() {
  const { session: authSession } = useAuth();
  const [authView, setAuthView] = useState<AuthView>("login");
  const [notice, setNotice] = useState<string | null>(null);

  function showLogin() {
    setNotice(null);
    setAuthView("login");
  }

  function showRegister() {
    setNotice(null);
    setAuthView("register");
  }

  function handleRegistered() {
    setNotice("Account created successfully. Sign in to continue.");
    setAuthView("login");
  }

  if (authSession !== null) {
    return <SessionPage />;
  }

  return authView === "login" ? (
    <LoginPage onRegister={showRegister} notice={notice} />
  ) : (
    <RegisterPage onRegistered={handleRegistered} onBackToLogin={showLogin} />
  );
}
