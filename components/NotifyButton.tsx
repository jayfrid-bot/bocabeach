"use client";

import { useEffect, useState } from "react";
import { disableNative, enableNative, isNativePlatform, nativeStatus } from "@/lib/push/native";

type State = "init" | "hidden" | "off" | "on" | "denied" | "busy" | "error";

const pill =
  "inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium ring-1 transition";

/**
 * "Notify me" opt-in for a beach: a morning Beach Day summary + safety alerts,
 * delivered as native push (APNs on iOS, FCM on Android) inside the app. Renders
 * nothing in a normal browser — push is an app-only feature now.
 */
export function NotifyButton({
  slug,
  serverNative = false,
}: {
  slug: string;
  /**
   * The server detected the native app shell from the request User-Agent. Trust
   * it: this is cache-proof and works even when the bundled @capacitor/core
   * mis-detects "web" on the remote URL. We still call the plugin on tap.
   */
  serverNative?: boolean;
}) {
  // When the server already knows we're in the app, start in "off" so the
  // button is in the SSR HTML immediately (no init flash); the effect then
  // refines it to on/denied. Browsers start "init" → render nothing.
  const [state, setState] = useState<State>(serverNative ? "off" : "init");
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    let tries = 0;
    const check = () => {
      if (!alive) return;
      if (serverNative || isNativePlatform()) {
        // Native confirmed — show the button NOW. Do NOT gate visibility on the
        // async plugin call below: if checkPermissions is slow or never resolves
        // (a flaky bridge round-trip), the button must still appear. nativeStatus
        // then refines it to on/denied.
        setState((s) => (s === "on" || s === "denied" ? s : "off"));
        nativeStatus(slug)
          .then((s) => alive && setState(s))
          .catch(() => alive && setState("off"));
        return;
      }
      // The Capacitor bridge can attach a beat after first paint on the remote
      // URL — retry briefly before concluding this is a plain browser.
      if (tries++ < 6) {
        setTimeout(check, 300);
        return;
      }
      setState("hidden"); // app-only; browsers don't get the button
    };
    check();
    return () => {
      alive = false;
    };
  }, [slug, serverNative]);

  const enable = async () => {
    setState("busy");
    setErr(null);
    try {
      await enableNative(slug, { morning: true, safety: true });
      setState("on");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setErr(msg);
      setState(/permission/i.test(msg) ? "denied" : "error");
    }
  };

  const disable = async () => {
    setState("busy");
    try {
      await disableNative(slug);
    } finally {
      setState("off");
    }
  };

  if (state === "init" || state === "hidden") return null;

  if (state === "denied") {
    return (
      <span
        className={`${pill} bg-slate-900/5 text-slate-500 ring-slate-900/10 dark:bg-white/5 dark:ring-white/10`}
        title="Notifications are blocked. Enable them for Is It Beach Day in your device Settings."
      >
        🔕 Notifications blocked
      </span>
    );
  }

  if (state === "on") {
    return (
      <span className={`${pill} bg-emerald-500/10 text-emerald-700 ring-emerald-500/20 dark:text-emerald-300`}>
        🔔 Alerts on
        <button onClick={disable} className="ml-1 underline hover:no-underline">
          turn off
        </button>
      </span>
    );
  }

  return (
    <span className="inline-flex flex-col items-start gap-1">
      <button
        onClick={enable}
        disabled={state === "busy"}
        className={`${pill} bg-ocean-500/10 text-ocean-700 ring-ocean-500/20 hover:bg-ocean-500/20 disabled:opacity-60 dark:text-ocean-300`}
        title={err ?? "Get a morning beach-day summary + safety alerts for this beach"}
      >
        🔔 {state === "busy" ? "Enabling…" : state === "error" ? "Try again" : "Notify me"}
      </button>
      {state === "error" && err ? (
        <span className="max-w-[280px] text-[11px] leading-tight text-rose-600 dark:text-rose-400">
          {err}
        </span>
      ) : null}
    </span>
  );
}
