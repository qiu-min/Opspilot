import { AlertCircle, ArrowLeft } from "lucide-react";
import { useState } from "react";
import { ApiError } from "../../api/client";
import { register } from "../../api/auth/auth-api";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { AuthPageShell } from "./auth-page-shell";

export type RegisterPageProps = {
  onRegistered: () => void;
  onBackToLogin: () => void;
};

export function RegisterPage({ onRegistered, onBackToLogin }: RegisterPageProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
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
      setErrorMessage("Enter a password.");
      return;
    }

    if (!confirmPassword) {
      setErrorMessage("Confirm your password.");
      return;
    }

    if (password !== confirmPassword) {
      setErrorMessage("Passwords do not match.");
      return;
    }

    setErrorMessage(null);
    setIsSubmitting(true);

    try {
      await register({ email: trimmedEmail, password });
      onRegistered();
    } catch (error: unknown) {
      setErrorMessage(getRegisterErrorMessage(error));
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <AuthPageShell>
      <div className="mb-8">
        <p className="mb-3 text-[10px] font-semibold uppercase tracking-[0.18em] text-mutedInk">Account setup</p>
        <h2 className="text-3xl font-semibold tracking-[-0.04em] text-ink sm:text-[34px]">Create your account</h2>
        <p className="mt-3 max-w-[390px] text-sm leading-6 text-mutedInk">Set up your OpsPilot workspace account to get started.</p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-5" noValidate>
        <div className="space-y-2">
          <label htmlFor="register-email" className="text-sm font-semibold text-ink">Email</label>
          <Input
            id="register-email"
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
          <label htmlFor="register-password" className="text-sm font-semibold text-ink">Password</label>
          <Input
            id="register-password"
            name="password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="new-password"
            placeholder="Create a password"
            disabled={isSubmitting}
            aria-describedby="register-password-hint"
            aria-invalid={errorMessage ? "true" : undefined}
          />
          <p id="register-password-hint" className="text-xs text-mutedInk">Password must be at least 8 characters.</p>
        </div>

        <div className="space-y-2">
          <label htmlFor="register-confirm-password" className="text-sm font-semibold text-ink">Confirm password</label>
          <Input
            id="register-confirm-password"
            name="confirmPassword"
            type="password"
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
            autoComplete="new-password"
            placeholder="Re-enter your password"
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

        <div className="space-y-3 pt-1">
          <Button type="submit" variant="primary" size="md" className="w-full" disabled={isSubmitting} aria-busy={isSubmitting}>
            {isSubmitting ? "Creating account..." : "Create account"}
          </Button>
          <Button type="button" variant="outline" size="md" className="w-full" onClick={onBackToLogin} disabled={isSubmitting}>
            <ArrowLeft size={16} aria-hidden="true" />
            Back to sign in
          </Button>
        </div>
      </form>
    </AuthPageShell>
  );
}

function getRegisterErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 409) {
      return error.detail || error.title || "An account with this email already exists.";
    }

    if (error.status === 400) {
      return error.detail || error.title || "Check your email and password.";
    }

    return error.detail || error.title || "Account creation failed. Try again.";
  }

  if (error instanceof TypeError) {
    return "Unable to reach OpsPilot. Check your connection and try again.";
  }

  return "Something went wrong while creating your account. Try again.";
}
