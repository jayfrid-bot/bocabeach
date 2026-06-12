"use client";

import { useEffect, useState } from "react";

type Theme = "light" | "dark" | "system";

function apply(theme: Theme) {
  const dark =
    theme === "dark" ||
    (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
}

/**
 * Light / dark / follow-system toggle. The saved choice is applied before
 * paint by the inline script in layout.tsx; this control just cycles it.
 */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme | null>(null);

  useEffect(() => {
    const saved = localStorage.getItem("theme");
    setTheme(saved === "light" || saved === "dark" ? saved : "system");
    // Track OS changes while in system mode.
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      if ((localStorage.getItem("theme") ?? "system") === "system") apply("system");
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const cycle = () => {
    const next: Theme = theme === "system" ? "light" : theme === "light" ? "dark" : "system";
    setTheme(next);
    if (next === "system") localStorage.removeItem("theme");
    else localStorage.setItem("theme", next);
    apply(next);
  };

  const icon = theme === "light" ? "☀️" : theme === "dark" ? "🌙" : "🌗";
  const label =
    theme === "light" ? "Light" : theme === "dark" ? "Dark" : "Auto";

  return (
    <button
      type="button"
      onClick={cycle}
      title={`Theme: ${label} — click to change`}
      aria-label={`Theme: ${label} — click to change`}
      className="inline-flex min-h-[36px] items-center gap-1.5 rounded-full bg-slate-900/5 px-3 py-1 text-xs text-slate-600 ring-1 ring-slate-900/10 transition hover:bg-slate-900/10 dark:bg-white/5 dark:text-slate-300 dark:ring-white/10 dark:hover:bg-white/10"
    >
      <span aria-hidden>{theme == null ? "🌗" : icon}</span>
      <span>{theme == null ? "Theme" : label}</span>
    </button>
  );
}
