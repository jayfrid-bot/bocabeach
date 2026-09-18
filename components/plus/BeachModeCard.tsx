"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { fmtTime } from "@/lib/format";
import { SAFETY_ALERT_KEYS } from "@/lib/db/types";
import { nearestServedBeach } from "@/lib/location/nearest";
import { plusErrorMessage } from "@/lib/plus/api";
import {
  ARM_THROTTLE_MS,
  AUTO_ARM_MS,
  MANUAL_ARM_MS,
  canAutoArm,
  coarsePosition,
  decideArm,
  establishesArrival,
  extendArmedUntil,
  isCurrentArmTicket,
  isSuppressed,
  resolveBeachModeView,
  resolveDelivery,
  shouldAutoArm,
  shouldClearSuppression,
  shouldRefreshPresence,
  shouldRetarget,
  type ArmMode,
  type DeliveryState,
} from "@/lib/plus/beachMode";
import { useDeviceFix, type PlusState } from "@/lib/plus/client";
import { readOffSuppression, writeOffSuppression } from "@/lib/plus/storage";
import type { OffSuppression } from "@/lib/plus/types";
import { nativeStatus } from "@/lib/push/native";
import { enableAlertsFlow } from "@/components/NotifyButton";
import type { LocationPublic } from "@/lib/types";

// Re-exported for components/plus/BeachModeCard.test.ts and anywhere else that
// used to import these from here — the rules themselves now live in
// lib/plus/beachMode.ts so they can be tested without rendering this card.
export { AUTO_ARM_MS, shouldAutoArm };

const CARD =
  "mb-4 rounded-2xl bg-white/80 px-4 py-3 ring-1 ring-slate-900/10 dark:bg-slate-900/70 dark:ring-white/10";
const CHIP =
  "inline-flex min-h-[40px] items-center rounded-full bg-slate-900/5 px-3.5 py-1.5 text-sm font-medium text-slate-700 transition hover:bg-slate-900/10 disabled:opacity-60 dark:bg-white/5 dark:text-slate-200 dark:hover:bg-white/10";
const PRIMARY =
  "inline-flex min-h-[40px] shrink-0 items-center rounded-full bg-ocean-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-ocean-700 disabled:opacity-60";

/**
 * Beach Mode: the window in which this phone gets alerts computed from where it
 * is standing, not from the middle of the beach.
 *
 * Walking up with the app open arms it for four hours by itself; anywhere else
 * it is one tap for six. Three separate operations share this card (LOC-02):
 * choosing/changing the monitored beach, refreshing the phone's position on an
 * armed session, and extending the expiry. Each arm request is ONE validated
 * decision made from the fix it fetched itself (LOC-04, LOC-12), and only the
 * newest request may win (R-02). Monitoring and delivery are shown as two
 * facts: the card never says "alerts on" without a usable push token (LOC-03).
 *
 * Free users see the same card as a door — it explains what it does and opens
 * the questions. App only: an alert with nowhere to be delivered is not worth
 * offering.
 */
export function BeachModeCard({
  plus,
  native,
  slug,
  beaches,
  tz,
  onDoor,
}: {
  plus: PlusState;
  native: boolean;
  slug: string;
  beaches: LocationPublic[];
  tz: string;
  /** Free users tapping the card — open the Plus questions. */
  onDoor: () => void;
}) {
  const { fix, requestFresh } = useDeviceFix();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [locked, setLocked] = useState(false); // the server said not-entitled
  const [suppression, setSuppression] = useState<OffSuppression | null>(null);
  // R-01: no automatic write may run before the saved Off is read.
  const [suppressionLoaded, setSuppressionLoaded] = useState(false);
  // LOC-03: the two delivery signals, folded by resolveDelivery().
  const [serverPushReady, setServerPushReady] = useState<boolean | null>(null);
  const [localPush, setLocalPush] = useState<"on" | "off" | "denied" | null>(null);
  const [pushBusy, setPushBusy] = useState(false);
  const [pushError, setPushError] = useState<string | null>(null);

  // R-02: every arm request takes a ticket; a result whose ticket is no
  // longer the newest is dropped, so an old callback can never overwrite a
  // newer intent (a later tap, a later arrival, an Off).
  const armSeqRef = useRef(0);
  const inFlightRef = useRef(false);
  const lastArmAtRef = useRef(0);
  const lastUploadAtRef = useRef(0);
  const lastUploadedFixAtRef = useRef<number | null>(null);

  // Off suppressions persist on the phone (bd:off-suppression), independent
  // of the server row, so a card that (re)mounts still honors an Off from
  // earlier in the session.
  useEffect(() => {
    setSuppression(readOffSuppression());
    setSuppressionLoaded(true);
  }, []);

  // The phone's own view of notifications, refreshed on every foreground: a
  // permission revoked in Settings must show up without a relaunch.
  useEffect(() => {
    if (!native) return;
    let alive = true;
    const read = () => {
      nativeStatus(slug)
        .then((s) => alive && setLocalPush(s))
        .catch(() => alive && setLocalPush(null));
    };
    read();
    const onVisible = () => {
      if (document.visibilityState === "visible") read();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [native, slug]);

  const presence = plus.device?.presence ?? null;
  const armedUntil = presence?.armedUntil ?? 0;
  const armed = !!presence && armedUntil > Date.now();
  const beachOf = (s: string) => beaches.find((b) => b.slug === s) ?? null;

  // The session fix is a PRE-check only ("worth asking the OS for a fresh
  // one?"); the arm decision itself is made from the fresh fix (LOC-04).
  const nearest = fix ? nearestServedBeach(fix.lat, fix.lon, beaches) : null;
  const arrivedHint = !!nearest && establishesArrival(fix, nearest.beach, Date.now());

  // Once a fix shows the phone has actually left the suppressed spot — or a
  // day has passed — drop the suppression so auto-arm is free to fire again
  // on the NEXT visit. Without this, returning within 24h would silently
  // inherit today's Off (the live isSuppressed check alone would re-trigger,
  // since it would still see a nearby fix and a same-day suppression).
  useEffect(() => {
    if (!suppression) return;
    if (shouldClearSuppression(suppression, Date.now(), fix)) {
      writeOffSuppression(null);
      setSuppression(null);
    }
  }, [suppression, fix]);

  const arm = useCallback(
    async (mode: ArmMode, opts: { ms: number; keepExpiry?: boolean }) => {
      const seq = ++armSeqRef.current;
      inFlightRef.current = true;
      setBusy(true);
      setError(null);
      if (mode === "manual") {
        // A deliberate On always wins over a previous Off, immediately — no
        // waiting on the network before it stops honoring a suppression the
        // user just overrode.
        writeOffSuppression(null);
        setSuppression(null);
      }
      // One validated decision (LOC-04): fetch a FRESH fix for this request,
      // then choose the target and the coordinates from THAT fix. A failed
      // fetch is a null fix, never a fallback to the session's older one
      // (LOC-06) — an automatic arm then simply does not happen.
      const freshFix = await requestFresh();
      if (!isCurrentArmTicket(seq, armSeqRef.current)) return; // a newer request took over
      const now = Date.now();
      const decision = decideArm({
        mode,
        freshFix,
        beaches,
        pageSlug: slug,
        presence: presence ? { slug: presence.slug, source: presence.source } : null,
        now,
      });
      if (!decision.ok) {
        inFlightRef.current = false;
        setBusy(false);
        return; // an arrival that did not hold up under a fresh fix is not an error
      }
      const res = await plus.arm({
        slug: decision.slug,
        ...decision.coords,
        // A presence refresh keeps the expiry exactly where it is (LOC-02):
        // it neither shortens nor needlessly extends the window.
        armedUntil: opts.keepExpiry ? armedUntil : extendArmedUntil(armedUntil, now, opts.ms),
        source: decision.source,
      });
      if (!isCurrentArmTicket(seq, armSeqRef.current)) return;
      inFlightRef.current = false;
      setBusy(false);
      if (res.ok) {
        setLocked(false);
        lastArmAtRef.current = now;
        lastUploadAtRef.current = now;
        lastUploadedFixAtRef.current = decision.coords.fixAt;
        if (res.pushReady !== undefined) setServerPushReady(res.pushReady);
        return;
      }
      // The server is the authority on entitlement: if it says no, this card
      // becomes the door again rather than arguing with a cached "yes".
      if (res.error === "not-entitled") setLocked(true);
      else setError(plusErrorMessage(res.error));
    },
    [armedUntil, beaches, plus, presence, requestFresh, slug],
  );

  // Automatic writes: arm on arrival, follow the phone to a different beach
  // (auto sessions only — a hand-picked beach is sticky), top the window up
  // when it is down to its last hour, and refresh the phone's position on an
  // armed session every few minutes. All gated on the saved state having
  // been read (R-01) — a cached entitlement plus a session fix must not fire
  // a write before the card knows about a saved Off or an existing session.
  useEffect(() => {
    if (!native || !plus.entitled || locked) return;
    if (!canAutoArm({ deviceLoaded: plus.deviceLoaded, suppressionLoaded })) return;
    const armIfDue = () => {
      if (inFlightRef.current) return;
      const now = Date.now();
      const nearestSlug = nearest?.beach.slug ?? null;
      const canArm = now - lastArmAtRef.current >= ARM_THROTTLE_MS;
      const suppressed = nearestSlug ? isSuppressed(suppression, nearestSlug, now, fix) : true;

      if (!armed) {
        // Arrival. The fresh fix inside arm() has the final say.
        if (arrivedHint && !suppressed && canArm) void arm("auto", { ms: AUTO_ARM_MS });
        return;
      }
      if (!presence) return;
      const current = presence ? { slug: presence.slug, source: presence.source } : null;
      if (shouldRetarget(current, nearestSlug, arrivedHint) && !suppressed && canArm) {
        void arm("auto", { ms: AUTO_ARM_MS });
        return;
      }
      const atMonitored = arrivedHint && nearestSlug === presence.slug;
      if (atMonitored && shouldAutoArm(now, lastArmAtRef.current, armedUntil)) {
        void arm("extend", { ms: AUTO_ARM_MS });
        return;
      }
      if (
        atMonitored &&
        shouldRefreshPresence(now, lastUploadAtRef.current, fix?.at ?? null, lastUploadedFixAtRef.current)
      ) {
        void arm("extend", { ms: 0, keepExpiry: true });
      }
    };
    armIfDue();
    const onVisible = () => {
      if (document.visibilityState === "visible") armIfDue();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [
    native,
    plus.entitled,
    plus.deviceLoaded,
    suppressionLoaded,
    locked,
    armed,
    presence,
    armedUntil,
    arrivedHint,
    nearest,
    suppression,
    fix,
    arm,
  ]);

  const disarm = async () => {
    armSeqRef.current += 1; // any arm still in flight loses to this Off (R-02)
    inFlightRef.current = false;
    setBusy(true);
    setError(null);
    if (presence) {
      // Remember the spot the phone was at when the user turned it off — to
      // two decimals, all "still standing here?" needs — so auto-arm can tell
      // "still here" from "came back another day", whichever beach the
      // nearest-math names next (the suppression is keyed on both).
      const centroid = beachOf(presence.slug);
      const raw = fix ? { lat: fix.lat, lon: fix.lon } : centroid ? { lat: centroid.lat, lon: centroid.lon } : null;
      if (raw) {
        const next: OffSuppression = { slug: presence.slug, since: Date.now(), ...coarsePosition(raw.lat, raw.lon) };
        writeOffSuppression(next);
        setSuppression(next);
      }
    }
    const res = await plus.disarm();
    setBusy(false);
    if (!res.ok && res.error !== "not-found") setError(plusErrorMessage(res.error));
  };

  const enableAlerts = async () => {
    setPushBusy(true);
    setPushError(null);
    const r = await enableAlertsFlow(slug, {
      morning: plus.prefs.morning,
      safety: SAFETY_ALERT_KEYS.some((k) => plus.prefs[k]),
    });
    setPushBusy(false);
    if (r.state === "on") {
      setLocalPush("on");
      setServerPushReady(true);
      return;
    }
    setLocalPush(r.state === "denied" ? "denied" : "off");
    setPushError(r.message);
  };

  if (!native) return null;

  const view = resolveBeachModeView({
    entitled: plus.entitled,
    locked,
    deviceLoaded: plus.deviceLoaded,
    armed,
  });

  // --- the door -------------------------------------------------------------
  if (view === "door") {
    return (
      <button type="button" onClick={onDoor} className={`${CARD} flex w-full items-center gap-3 text-left`}>
        <span aria-hidden className="shrink-0 text-xl leading-none">
          🛟
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold text-slate-900 dark:text-white">
            Get alerts where you stand
          </span>
          <span className="block text-xs leading-snug text-slate-600 dark:text-slate-400">
            Lightning, flags and rain measured from your spot on the sand, not the middle of the beach.
          </span>
        </span>
        <span aria-hidden className="shrink-0 text-slate-400">
          ›
        </span>
      </button>
    );
  }

  // --- loading: the device row (presence included) has not been read yet ---
  // Without this, a fresh cache reads as "nothing armed" for a moment and the
  // card would offer to start a window that may already be running server-side.
  if (view === "loading") {
    return (
      <div className={CARD}>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          <span aria-hidden className="mr-1.5">
            🛟
          </span>
          Checking Beach Mode…
        </p>
      </div>
    );
  }

  // --- armed ----------------------------------------------------------------
  if (view === "armed" && presence) {
    const target = beachOf(presence.slug);
    const beachName = target?.name ?? presence.slug;
    // The session's own beach sets the clock, not the page's (LOC-05).
    const until = fmtTime(new Date(presence.armedUntil).toISOString(), target?.timezone ?? tz);
    const delivery: DeliveryState = resolveDelivery(serverPushReady, localPush);
    const geometry = presence.hasFix
      ? "Measured from your spot on the sand."
      : `Measured from ${beachName} itself — no fresh position from this phone.`;
    return (
      <div className={CARD}>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <span className="min-w-0 flex-1 text-sm text-slate-800 dark:text-slate-200">
            <span aria-hidden className="mr-1.5">
              🛟
            </span>
            {delivery === "ready" ? (
              <>
                <span className="font-semibold">Safety alerts on</span> for {beachName} until {until}
              </>
            ) : (
              <>
                <span className="font-semibold">Watching {beachName}</span> until {until}
              </>
            )}
          </span>
          <div className="flex shrink-0 gap-2">
            <button
              type="button"
              onClick={() => void arm("extend", { ms: AUTO_ARM_MS })}
              disabled={busy}
              className={CHIP}
            >
              Extend
            </button>
            <button type="button" onClick={() => void disarm()} disabled={busy} className={CHIP}>
              Off
            </button>
          </div>
        </div>
        <p className="mt-1.5 text-xs leading-snug text-slate-500 dark:text-slate-400">{geometry}</p>
        {delivery === "needs-setup" ? (
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
            <span className="min-w-0 flex-1 text-sm text-amber-700 dark:text-amber-300">
              Turn on notifications to get alerts — we are watching, but nothing can reach this phone yet.
            </span>
            <button type="button" onClick={() => void enableAlerts()} disabled={pushBusy} className={PRIMARY}>
              {pushBusy ? "One moment…" : "Turn on notifications"}
            </button>
          </div>
        ) : null}
        {delivery === "denied" ? (
          <p className="mt-2 text-sm text-amber-700 dark:text-amber-300">
            Notifications are blocked for Is It Beach Day in your phone&apos;s Settings, so alerts
            can&apos;t reach you. Allow them there, then come back.
          </p>
        ) : null}
        {delivery === "unknown" ? (
          <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">Checking notifications…</p>
        ) : null}
        {pushError ? (
          <p role="alert" className="mt-2 text-sm text-rose-600 dark:text-rose-400">
            {pushError}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="mt-2 text-sm text-rose-600 dark:text-rose-400">
            {error}
          </p>
        ) : null}
      </div>
    );
  }

  // --- not armed ------------------------------------------------------------
  return (
    <div className={CARD}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="min-w-0 flex-1 text-sm text-slate-800 dark:text-slate-200">
          <span aria-hidden className="mr-1.5">
            🛟
          </span>
          {arrivedHint && busy ? "Turning safety alerts on…" : "Heading to the beach?"}
        </span>
        <button
          type="button"
          onClick={() => void arm("manual", { ms: MANUAL_ARM_MS })}
          disabled={busy}
          className={PRIMARY}
        >
          {busy ? "One moment…" : "Turn on for 6 hours"}
        </button>
      </div>
      {!fix ? (
        <p className="mt-1.5 text-xs leading-snug text-slate-500 dark:text-slate-400">
          Without a position we watch this beach rather than your exact spot.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="mt-2 text-sm text-rose-600 dark:text-rose-400">
          {error}
        </p>
      ) : null}
    </div>
  );
}
