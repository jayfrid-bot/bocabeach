"use client";

import { useEffect } from "react";

/**
 * Global error boundary. Unlike app/error.tsx, this catches errors thrown in the
 * ROOT layout itself, so React unmounts the whole tree — we must render our own
 * <html>/<body>. The layout's pre-paint theme script never ran here, so we inline
 * a resolved-theme background (stored choice → device fallback) to avoid a
 * wrong-theme flash, and offer a hard reload to recover.
 */
const THEME_SCRIPT = `(function(){try{var t=localStorage.getItem("theme");var d=t==="dark"||(t!=="light"&&matchMedia("(prefers-color-scheme: dark)").matches);document.documentElement.classList.toggle("dark",d);document.documentElement.style.background=d?"#020617":"#f3f7fb";document.documentElement.style.color=d?"#f1f5f9":"#0f172a";}catch(e){}})();`;

export default function GlobalError({
  error,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: "1rem",
          padding: "0 1.5rem",
          textAlign: "center",
          fontFamily:
            "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
        }}
      >
        <h1 style={{ fontSize: "1.875rem", fontWeight: 700, margin: 0 }}>
          Something went sideways
        </h1>
        <p style={{ margin: 0, opacity: 0.7 }}>
          The app hit an unexpected error. Reloading usually clears it.
        </p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          style={{
            minHeight: 40,
            padding: "0.5rem 1.25rem",
            borderRadius: 9999,
            border: "1px solid rgba(127,127,127,0.3)",
            background: "transparent",
            color: "inherit",
            fontSize: "0.875rem",
            fontWeight: 500,
            cursor: "pointer",
          }}
        >
          Reload
        </button>
      </body>
    </html>
  );
}
