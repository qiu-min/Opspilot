import type { HTMLAttributes } from "react";
import { cn } from "../../lib/utils";

type BadgeTone = "neutral" | "blue" | "teal" | "orange" | "navy";

export function Badge({ className, tone = "neutral", ...props }: HTMLAttributes<HTMLSpanElement> & { tone?: BadgeTone }) {
  const toneClasses: Record<BadgeTone, string> = {
    neutral: "bg-slate-100 text-mutedInk",
    blue: "bg-blue-50 text-brand-strong",
    teal: "bg-teal/10 text-teal",
    orange: "bg-orange-50 text-[#b6532e]",
    navy: "bg-navy/10 text-navy",
  };

  return (
    <span
      className={cn("inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold tracking-[0.01em]", toneClasses[tone], className)}
      {...props}
    />
  );
}
