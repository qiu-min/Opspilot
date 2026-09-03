import type { ButtonHTMLAttributes } from "react";
import { cn } from "../../lib/utils";

type ButtonVariant = "primary" | "secondary" | "ghost" | "outline" | "sidebar";
type ButtonSize = "sm" | "md" | "icon";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

const variantClasses: Record<ButtonVariant, string> = {
  primary: "bg-accent text-navy hover:bg-[#cf633b] shadow-sm",
  secondary: "bg-ink text-white hover:bg-[#253650]",
  ghost: "text-mutedInk hover:bg-slate-100 hover:text-ink",
  outline: "border border-line bg-surface text-ink hover:border-brand/40 hover:bg-slate-50",
  sidebar: "text-navy-muted hover:bg-white/[0.1] hover:text-white",
};

const sizeClasses: Record<ButtonSize, string> = {
  sm: "min-h-9 rounded-lg px-3 text-xs",
  md: "min-h-11 rounded-xl px-4 text-sm",
  icon: "h-10 w-10 rounded-lg p-0",
};

export function Button({ className, variant = "ghost", size = "md", type = "button", ...props }: ButtonProps) {
  return (
    <button
      type={type}
      className={cn(
        "inline-flex cursor-pointer items-center justify-center gap-2 font-medium transition duration-200 ease-snappy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/60 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50",
        variantClasses[variant],
        sizeClasses[size],
        className,
      )}
      {...props}
    />
  );
}
