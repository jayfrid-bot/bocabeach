"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";
import type { ReactNode } from "react";

/**
 * Wraps next-themes so the day/night theme is persisted and applied as
 * `data-theme="day" | "night"` on <html>. Defaults to the OS preference.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  return (
    <NextThemesProvider
      attribute="data-theme"
      defaultTheme="system"
      enableSystem
      value={{ light: "day", dark: "night" }}
    >
      {children}
    </NextThemesProvider>
  );
}
