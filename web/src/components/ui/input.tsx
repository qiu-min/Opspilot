import type { InputHTMLAttributes } from "react";
import { cn } from "../../lib/utils";

export function Input({ className, type = "text", ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      type={type}
      className={cn(
        "h-11 w-full rounded-lg border border-line bg-surface px-3.5 text-sm text-ink outline-none transition duration-200 placeholder:text-mutedInk/65 hover:border-brand/35 focus-visible:border-brand focus-visible:ring-2 focus-visible:ring-brand/20 disabled:cursor-not-allowed disabled:opacity-60",
        className,
      )}
      {...props}
    />
  );
}
