import { AlertCircle, CheckCircle2 } from "lucide-react";
import { useState } from "react";
import { ApiError } from "../../api/client";
import { login } from "../../api/auth/auth-api";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import type { AuthSession } from "./auth-session";
import { AuthPageShell } from "./auth-page-shell";
import { useAuth } from "./auth-provider";

export type LoginPageProps = {
  onRegister: () => void;
  notice?: string | null;
};

export function LoginPage({ onRegister, notice }: LoginPageProps) {
  const { setSession } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const trimmedEmail = email.trim();
    if (!trimmedEmail) {
      setErrorMessage("Enter your email address.");
      return;
    }

    if (!password) {
      setErrorMessage("Enter your password.");
      return;
    }

    setErrorMessage(null);
    setIsSubmitting(true);

    try {
      const response = await login({ email: trimmedEmail, password });
      const session: AuthSession = {
        userId: response.userId,
        email: response.email,
        accessToken: response.accessToken,
        expiresAtUtc: response.expiresAtUtc,
      };

      setSession(session);
    } catch (error: unknown) {
      setErrorMessage(getLoginErrorMessage(error));
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <AuthPageShell>
      <div className="mb-8">
        <p className="mb-3 text-[10px] font-semibold uppercase tracking-[0.18em] text-mutedInk">Account access</p>
        <h2 className="text-3xl font-semibold tracking-[-0.04em] text-ink sm:text-[34px]">Sign in to OpsPilot</h2>
        <p className="mt-3 max-w-[390px] text-sm leading-6 text-mutedInk">Use your workspace credentials to continue.</p>
      </div>

      {notice && (
        <div role="status" className="mb-5 flex items-start gap-2.5 rounded-lg border border-teal/20 bg-teal/[0.06] px-3.5 py-3 text-sm text-teal">
          <CheckCircle2 size={17} className="mt-0.5 shrink-0" aria-hidden="true" />
          <p>{notice}</p>
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-5" noValidate>
        <div className="space-y-2">
          <label htmlFor="login-email" className="text-sm font-semibold text-ink">Email</label>
          <Input
            id="login-email"
            name="email"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            autoComplete="email"
            inputMode="email"
            placeholder="you@company.com"
            disabled={isSubmitting}
            aria-invalid={errorMessage ? "true" : undefined}
          />
        </div>

        <div className="space-y-2">
          <label htmlFor="login-password" className="text-sm font-semibold text-ink">Password</label>
          <Input
            id="login-password"
            name="password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            placeholder="Enter your password"
            disabled={isSubmitting}
            aria-invalid={errorMessage ? "true" : undefined}
          />
        </div>

        {errorMessage && (
          <div role="alert" className="flex items-start gap-2.5 rounded-lg border border-danger/25 bg-danger/[0.06] px-3.5 py-3 text-sm text-danger">
            <AlertCircle size={17} className="mt-0.5 shrink-0" aria-hidden="true" />
            <p>{errorMessage}</p>
          </div>
        )}

        <Button type="submit" variant="primary" size="md" className="w-full" disabled={isSubmitting} aria-busy={isSubmitting}>
          {isSubmitting ? "Signing in..." : "Sign in"}
        </Button>
      </form>

      <div className="mt-6 border-t border-line pt-5">
        <p className="mb-3 text-center text-xs text-mutedInk">New to OpsPilot?</p>
        <Button type="button" variant="outline" size="md" className="w-full" onClick={onRegister} disabled={isSubmitting}>Create account</Button>
      </div>
    </AuthPageShell>
  );
}

function getLoginErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) {
      return error.detail || error.title || "The email or password is incorrect.";
    }

    if (error.status === 400) {
      return error.detail || error.title || "Check your email and password.";
    }

    return error.detail || error.title || "Sign in failed. Try again.";
  }

  if (error instanceof TypeError) {
    return "Unable to reach OpsPilot. Check your connection and try again.";
  }

  return "Something went wrong while signing in. Try again.";
}
