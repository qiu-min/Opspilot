import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        canvas: "hsl(var(--canvas))",
        surface: "hsl(var(--surface))",
        ink: "hsl(var(--ink))",
        mutedInk: "hsl(var(--muted-ink))",
        line: "hsl(var(--line))",
        brand: "hsl(var(--brand))",
        "brand-strong": "hsl(var(--brand-strong))",
        accent: "hsl(var(--accent))",
        teal: "hsl(var(--teal))",
        navy: "hsl(var(--navy))",
        "navy-muted": "hsl(var(--navy-muted))",
        danger: "hsl(var(--danger))",
      },
      fontFamily: {
        sans: ["Plus Jakarta Sans", "Noto Sans SC", "ui-sans-serif", "system-ui", "sans-serif"],
      },
      boxShadow: {
        hairline: "0 1px 2px rgba(15, 23, 42, 0.04)",
        panel: "0 8px 24px rgba(15, 23, 42, 0.06)",
      },
      transitionTimingFunction: {
        snappy: "cubic-bezier(0.22, 1, 0.36, 1)",
      },
    },
  },
  plugins: [],
} satisfies Config;
