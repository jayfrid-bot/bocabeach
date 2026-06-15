"use client";

import { useEffect } from "react";

/**
 * Route-level error boundary. Catches render/data errors below the layout and
 * offers a recovery path — reset() re-renders the segment (a soft retry that
 * re-runs the failed fetch) without a full reload. Themed + dark-aware to match
 * the rest of the app.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Surface for Cloudflare/console; the digest links to the server log.
    console.error(error);
  }, [error]);

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col items-center justify-center gap-4 px-6 text-center">
      <h1 className="text-3xl font-bold">Something went sideways</h1>
      <p className="text-slate-600 dark:text-slate-400">
        We couldn&apos;t load the conditions just now. Give it another shot.
      </p>
      <button
        type="button"
        onClick={reset}
        className="inline-flex min-h-[40px] items-center rounded-full bg-slate-900/5 px-5 py-2 text-sm font-medium text-slate-700 ring-1 ring-slate-900/10 transition hover:bg-slate-900/10 dark:bg-white/5 dark:text-slate-200 dark:ring-white/10 dark:hover:bg-white/10"
      >
        Try again
      </button>
    </main>
  );
}
