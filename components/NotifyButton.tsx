"use client";

import { useEffect, useState } from "react";
import {
  isPushSupported,
  pushStatus,
  subscribeToPush,
  unsubscribeFromPush,
} from "@/lib/push/client";
import { VAPID_PUBLIC_KEY } from "@/lib/push/vapid";

type State = "init" | "hidden" | "off" | "on" | "denied" | "busy" | "error";

const pill =
  "inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium ring-1 transition";

/**
 * "Notify me" opt-in for a beach: a morning Beach Day summary + safety alerts
 * via Web Push. Renders nothing where push can't work (iOS WKWebView, older
 * browsers) or before VAPID keys are configured, so it never offers a dead
 * control.
 */
export function NotifyButton({ slug }: { slug: string }) {
  const [state, setState] = useState<State>("init");
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!isPushSupported() || !VAPID_PUBLIC_KEY) {
      setState("hidden");
      return;
    }
    let alive = true;
    // pushStatus() awaits navigator.serviceWorker.ready, which never resolves if
    // SW registration failed — race a timeout so we don't hang in "init" forever.
    const timeout = new Promise<"timeout">((res) => setTimeout(() => res("timeout"), 5000));
    Promise.race([pushStatus(), timeout])
      .then((r) => {
        if (!alive) return;
        if (r === "timeout") return setState("hidden"); // no usable SW → don't offer
        setState(r.permission === "denied" ? "denied" : r.subscribed ? "on" : "off");
      })
      .catch(() => alive && setState("off"));
    return () => {
      alive = false;
    };
  }, []);

  const enable = async () => {
    setState("busy");
    setErr(null);
    try {
      await subscribeToPush(slug, { morning: true, safety: true });
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
      await unsubscribeFromPush();
    } finally {
      setState("off");
    }
  };

  if (state === "init" || state === "hidden") return null;

  if (state === "denied") {
    return (
      <span
        className={`${pill} bg-slate-900/5 text-slate-500 ring-slate-900/10 dark:bg-white/5 dark:ring-white/10`}
        title="Notifications are blocked for this site. Enable them in your browser settings."
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
    <button
      onClick={enable}
      disabled={state === "busy"}
      className={`${pill} bg-ocean-500/10 text-ocean-700 ring-ocean-500/20 hover:bg-ocean-500/20 disabled:opacity-60 dark:text-ocean-300`}
      title={err ?? "Get a morning beach-day summary + safety alerts for this beach"}
    >
      🔔 {state === "busy" ? "Enabling…" : state === "error" ? "Try again" : "Notify me"}
    </button>
  );
}
