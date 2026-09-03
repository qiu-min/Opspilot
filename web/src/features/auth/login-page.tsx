import { AlertCircle, Sparkles } from "lucide-react";
import { useState } from "react";
import { ApiError } from "../../api/client";
import { login } from "../../api/auth/auth-api";
import type { AuthSession } from "./auth-session";
import { useAuth } from "./auth-provider";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";

export function LoginPage() {
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
    <div className="min-h-dvh bg-canvas text-ink lg:grid lg:grid-cols-[minmax(320px,0.82fr)_minmax(500px,1.18fr)]">
      <section className="hidden min-h-dvh flex-col justify-between bg-navy px-8 py-8 text-white lg:flex xl:px-12" aria-label="OpsPilot introduction">
        <BrandMark />
        <div className="max-w-[440px] pb-6">
          <p className="mb-4 text-[10px] font-semibold uppercase tracking-[0.18em] text-navy-muted">Operational intelligence</p>
          <h1 className="max-w-[420px] text-4xl font-semibold leading-[1.08] tracking-[-0.045em] xl:text-[44px]">A clear workspace for complex operations.</h1>
          <p className="mt-6 max-w-[390px] text-sm leading-6 text-navy-muted">Bring operational data into one focused workspace and move from questions to confident next steps.</p>
        </div>
        <p className="border-t border-white/10 pt-5 text-xs text-navy-muted">AI workspace for operational data</p>
      </section>

      <main className="flex min-h-dvh min-w-0 flex-col bg-canvas">
        <header className="flex items-center justify-between px-5 py-5 sm:px-8 lg:justify-end lg:px-12">
          <div className="flex items-center gap-2.5 lg:hidden">
            <div className="flex h-8 w-8 items-center justify-center rounded-[10px] bg-accent text-navy" aria-hidden="true"><Sparkles size={16} strokeWidth={2.3} /></div>
            <span className="text-[15px] font-bold tracking-[-0.02em]">opspilot</span>
          </div>
          <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-mutedInk">Workspace access</span>
        </header>

        <div className="flex flex-1 items-center justify-center px-5 py-10 sm:px-8 lg:px-12 lg:py-16">
          <div className="w-full max-w-[440px]">
            <div className="mb-8">
              <p className="mb-3 text-[10px] font-semibold uppercase tracking-[0.18em] text-mutedInk">Account access</p>
              <h2 className="text-3xl font-semibold tracking-[-0.04em] text-ink sm:text-[34px]">Sign in to OpsPilot</h2>
              <p className="mt-3 max-w-[390px] text-sm leading-6 text-mutedInk">Use your workspace credentials to continue.</p>
            </div>

            <form onSubmit={handleSubmit} className="space-y-5" noValidate>
              <div className="space-y-2">
                <label htmlFor="login-email" className="text-sm font-semibold text-ink">Email</label>
                <Input
                  id="login-email"
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
          </div>
        </div>
      </main>
    </div>
  );
}

function BrandMark() {
  return (
    <div className="flex items-center gap-2.5">
      <div className="flex h-8 w-8 items-center justify-center rounded-[10px] bg-accent text-navy" aria-hidden="true"><Sparkles size={16} strokeWidth={2.3} /></div>
      <span className="text-[15px] font-bold tracking-[-0.02em]">opspilot</span>
    </div>
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
