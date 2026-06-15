"use client";

import { useEffect, useState } from "react";

const systemPrefersDark = () =>
  window.matchMedia("(prefers-color-scheme: dark)").matches;
const resolvedIsDark = () =>
  document.documentElement.classList.contains("dark");

/**
 * Theme toggle. Shows what clicking will switch you TO (a sun when the page is
 * dark, a moon when it's light) — the standard toggle affordance.
 *
 * Auto-follows the device until you make an explicit choice: with no stored
 * preference we track `prefers-color-scheme` live. The pre-paint script in
 * layout.tsx resolves the same way (stored choice → that; otherwise device),
 * so there's no flash. Toggling to the theme your device is already in clears
 * the override and returns you to auto-follow — so "auto" just works without
 * a confusing third state.
 */
export function ThemeToggle() {
  const [isDark, setIsDark] = useState<boolean | null>(null);

  useEffect(() => {
    setIsDark(resolvedIsDark());
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      // Only follow the device while the user hasn't pinned a choice.
      if (!localStorage.getItem("theme")) {
        document.documentElement.classList.toggle("dark", mq.matches);
        setIsDark(mq.matches);
      }
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const toggle = () => {
    const next = !resolvedIsDark();
    document.documentElement.classList.toggle("dark", next);
    setIsDark(next);
    // Match the device → back to auto-follow; otherwise pin the explicit choice.
    if (next === systemPrefersDark()) localStorage.removeItem("theme");
    else localStorage.setItem("theme", next ? "dark" : "light");
  };

  // The label/icon describe the RESULT of a click (the opposite of what shows).
  const switchTo = isDark == null ? null : isDark ? "Light" : "Dark";
  const icon = switchTo === "Light" ? "☀️" : switchTo === "Dark" ? "🌙" : "🌓";

  return (
    <button
      type="button"
      onClick={toggle}
      title={switchTo ? `Switch to ${switchTo.toLowerCase()} mode` : "Switch theme"}
      aria-label={switchTo ? `Switch to ${switchTo.toLowerCase()} mode` : "Switch theme"}
      className="inline-flex min-h-[36px] items-center gap-1.5 rounded-full bg-slate-900/5 px-3 py-1 text-xs text-slate-600 ring-1 ring-slate-900/10 transition hover:bg-slate-900/10 dark:bg-white/5 dark:text-slate-300 dark:ring-white/10 dark:hover:bg-white/10"
    >
      <span aria-hidden>{icon}</span>
      <span>{switchTo ? `${switchTo} mode` : "Theme"}</span>
    </button>
  );
}
