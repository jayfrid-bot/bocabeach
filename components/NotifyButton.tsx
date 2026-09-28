"use client";

import { useEffect, useState } from "react";
import { disableNative, enableNative, isNativePlatform, nativeStatus } from "@/lib/push/native";

type State = "init" | "hidden" | "off" | "on" | "denied" | "busy" | "error";

/**
 * The one notification-setup flow, shared with Beach Mode (LOC-03): ask the
 * OS, register the token, store it against this device. "denied" only when
 * the OS itself says so — see the note in `enable` below; anything else is a
 * retryable error carrying its message.
 */
export async function enableAlertsFlow(
  slug: string,
  prefs: { morning: boolean; safety: boolean },
): Promise<{ state: "on" } | { state: "denied" | "error"; message: string }> {
  try {
    await enableNative(slug, prefs);
    return { state: "on" };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const perm = await nativeStatus(slug).catch(() => "off" as const);
    return { state: perm === "denied" ? "denied" : "error", message };
  }
}

// Shared 44px icon-button chrome, matching the other two header buttons
// (Share, dark-mode) it sits beside — see components/ConditionsDashboard.tsx.
const iconBtn =
  "relative inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full ring-1 transition disabled:opacity-60";
const iconBtnNeutral = `${iconBtn} bg-slate-900/5 text-slate-600 ring-slate-900/10 hover:bg-slate-900/10 dark:bg-white/5 dark:text-slate-300 dark:ring-white/10 dark:hover:bg-white/10`;

/** A small state dot pinned to the bell's corner — the on/off/blocked signal
 *  a screen reader gets from `aria-label` alone, and a sighted glance gets
 *  from color without reading anything. */
function StateDot({ color }: { color: "emerald" | "rose" }) {
  const bg = color === "emerald" ? "bg-emerald-500" : "bg-rose-500";
  return (
    <span
      aria-hidden
      className={`absolute right-1.5 top-1.5 h-2 w-2 rounded-full ${bg} ring-2 ring-white dark:ring-slate-950`}
    />
  );
}

/**
 * The Alerts door.
 *
 * Free: tapping it opens the Plus questions — alerts are the paid half of the
 * app, and pretending otherwise by asking for a notification permission we
 * cannot use would be worse than saying so.
 * Plus: the original opt-in, unchanged — permission, APNs/FCM registration, and
 * the token stored against this device — plus a way into the settings sheet.
 *
 * Renders nothing in a normal browser: push is an app-only feature.
 */
export function NotifyButton({
  slug,
  serverNative = false,
  entitled = false,
  prefs = { morning: true, safety: true },
  onDoor,
  onSettings,
}: {
  slug: string;
  /**
   * The server detected the native app shell from the request User-Agent. Trust
   * it: this is cache-proof and works even when the bundled @capacitor/core
   * mis-detects "web" on the remote URL. We still call the plugin on tap.
   */
  serverNative?: boolean;
  /** Beach Day Plus is active on this device. */
  entitled?: boolean;
  /** This device's saved alert choices, in the two switches push understands. */
  prefs?: { morning: boolean; safety: boolean };
  /** Free tap — open the Plus questions. */
  onDoor?: () => void;
  /** Plus tap once alerts are on — open the settings sheet. */
  onSettings?: () => void;
}) {
  // When the server already knows we're in the app, start in "off" so the
  // button is in the SSR HTML immediately (no init flash); the effect then
  // refines it to on/denied. Browsers start "init" → render nothing.
  const [state, setState] = useState<State>(serverNative ? "off" : "init");
  const [err, setErr] = useState<string | null>(null);
  // Icon-only "on" state opens a small menu (Settings / Turn off) instead of
  // showing those as separate inline links — same two actions, one tap away.
  const [menuOpen, setMenuOpen] = useState(false);

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
    // No entitlement, no alerts to enable — send them to the offer instead.
    if (!entitled) {
      onDoor?.();
      return;
    }
    setState("busy");
    setErr(null);
    // "Blocked" is a claim about the OS setting, so ask the OS. Matching the
    // error text used to label any not-yet-granted permission as blocked — a
    // person who had just tapped Allow was told they had said no (seen on the
    // iOS simulator 2026-09-05). Only a real "denied" from the permission check
    // earns the blocked label; everything else is a retryable error.
    const r = await enableAlertsFlow(slug, prefs);
    if (r.state === "on") {
      setState("on");
      return;
    }
    setErr(r.message);
    setState(r.state);
  };

  const disable = async () => {
    setMenuOpen(false);
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
        className={`${iconBtnNeutral} cursor-default text-slate-500 dark:text-slate-400`}
        title="Notifications are blocked. Enable them for Is It Beach Day in your device Settings."
        aria-label="Alerts blocked — enable notifications in your device Settings"
      >
        <span aria-hidden className="text-lg leading-none">
          🔕
        </span>
        <StateDot color="rose" />
      </span>
    );
  }

  if (state === "on") {
    return (
      <span className="relative inline-block">
        <button
          type="button"
          onClick={() => setMenuOpen((v) => !v)}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label="Alerts on for this beach — tap for settings"
          className={`${iconBtn} bg-emerald-500/10 text-emerald-700 ring-emerald-500/20 hover:bg-emerald-500/20 dark:text-emerald-300`}
        >
          <span aria-hidden className="text-lg leading-none">
            🔔
          </span>
          <StateDot color="emerald" />
        </button>
        {menuOpen ? (
          <>
            {/* Outside-tap dismiss — same pattern as Sheet's backdrop, just
                without the scroll lock/focus trap a full modal needs for two
                one-line actions. */}
            <button
              type="button"
              aria-label="Close menu"
              onClick={() => setMenuOpen(false)}
              className="fixed inset-0 z-40 cursor-default"
            />
            <div
              role="menu"
              aria-label="Alert options"
              className="absolute right-0 top-full z-50 mt-2 w-44 overflow-hidden rounded-xl bg-white py-1 shadow-lg ring-1 ring-slate-900/10 dark:bg-slate-800 dark:ring-white/10"
            >
              {onSettings ? (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    onSettings();
                  }}
                  className="flex min-h-[44px] w-full items-center px-4 text-left text-sm text-slate-700 hover:bg-slate-900/5 dark:text-slate-200 dark:hover:bg-white/10"
                >
                  Alert settings
                </button>
              ) : null}
              <button
                type="button"
                role="menuitem"
                onClick={disable}
                className="flex min-h-[44px] w-full items-center px-4 text-left text-sm text-slate-700 hover:bg-slate-900/5 dark:text-slate-200 dark:hover:bg-white/10"
              >
                Turn off alerts
              </button>
            </div>
          </>
        ) : null}
      </span>
    );
  }

  // off / busy / error — one tap enables (or, without an entitlement, opens
  // the Plus door); the aria-label carries the same "🔔 Alerts" wording the
  // free-tap flow has always been found by (see e2e/plus.spec.ts).
  const label =
    state === "busy"
      ? "🔔 Alerts — enabling…"
      : state === "error"
        ? "🔔 Alerts — try again"
        : "🔔 Alerts";
  return (
    <button
      type="button"
      onClick={enable}
      disabled={state === "busy"}
      aria-label={label}
      title={
        err ??
        (entitled
          ? "Turn on safety and morning alerts for this beach"
          : "Safety and morning alerts are part of Beach Day Plus")
      }
      className={iconBtnNeutral}
    >
      <span aria-hidden className="text-lg leading-none">
        🔔
      </span>
      {state === "error" ? <StateDot color="rose" /> : null}
    </button>
  );
}
