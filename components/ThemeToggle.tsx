"use client";

import { useEffect, useState } from "react";
import { useTheme } from "next-themes";

/** Day/night toggle button (sits top-right of the banner). */
export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // Avoid a hydration mismatch: treat as day until mounted.
  const isNight = mounted && resolvedTheme === "dark";

  return (
    <button
      type="button"
      onClick={() => setTheme(isNight ? "light" : "dark")}
      aria-label={isNight ? "Switch to day theme" : "Switch to night theme"}
      title={isNight ? "Day theme" : "Night theme"}
      className="flex h-10 w-10 items-center justify-center rounded-full bg-foam/85 text-lg shadow-soft ring-1 ring-ink/10 backdrop-blur transition hover:scale-105"
    >
      <span aria-hidden suppressHydrationWarning>
        {isNight ? "☀️" : "🌙"}
      </span>
    </button>
  );
}
