import { Sparkles } from "lucide-react";
import type { ReactNode } from "react";

export function AuthPageShell({ children }: { children: ReactNode }) {
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
          <div className="lg:hidden"><BrandMark /></div>
          <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-mutedInk">Workspace access</span>
        </header>

        <div className="flex flex-1 items-center justify-center px-5 py-10 sm:px-8 lg:px-12 lg:py-16">
          <div className="w-full max-w-[440px]">{children}</div>
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
