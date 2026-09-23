"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import useSWR from "swr";
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
import { useDeviceFix, useHazardsAtPoint, type PlusState } from "@/lib/plus/client";
import { beachModeHazardLine } from "@/lib/hazards/pointVsBeach";
import { contentStateFromConditions, hashContentState } from "@/lib/liveActivity/state";
import * as liveActivity from "@/lib/plus/liveActivity";
import type { BeachSessionWireState } from "@/lib/plus/liveActivity";
import {
  readLiveActivityDismissal,
  readLiveActivityPref,
  readOffSuppression,
  writeLiveActivityDismissal,
  writeLiveActivityPref,
  writeOffSuppression,
} from "@/lib/plus/storage";
import type { OffSuppression } from "@/lib/plus/types";
import { nativeStatus } from "@/lib/push/native";
import { enableAlertsFlow } from "@/components/NotifyButton";
import type { ConditionsResponse, LocationPublic } from "@/lib/types";

// Beach Session Live Activity update budget: never more than once per this
// window (docs/LIVE_ACTIVITY_PLAN.md Phase 2) — matched to the conditions
// poll interval below so one fetch drives at most one bridge update.
//
// 60s is deliberate, not a placeholder: ActivityKit budgets local-push
// activity updates and a tighter interval risks the OS throttling or
// dropping them, while the Lock Screen numbers (wind/wave/score) don't move
// fast enough for anything tighter to matter to a reader. This card's own
// dedicated poll (rather than reusing the dashboard's conditions fetch for
// `slug`) is intentional too: the Live Activity tracks `armedTarget`, which
// can differ from the page's displayed `slug` once Beach Mode has retargeted
// to wherever the phone actually is.
const LIVE_ACTIVITY_MIN_UPDATE_MS = 60_000;

// Same footer build stamp components/ConditionsDashboard.tsx reads — passed
// to the plugin so a token upload (or an end report) can be traced back to
// the build that requested it. Optional: undefined in a dev build is fine,
// the server field it fills is optional too.
const LA_APP_BUILD = process.env.NEXT_PUBLIC_BUILD_NUM;

const conditionsFetcher = (u: string) =>
  fetch(u).then((r) => {
    if (!r.ok) throw new Error(String(r.status));
    return r.json();
  });

// Re-exported for components/plus/BeachModeCard.test.ts and anywhere else that
// used to import these from here — the rules themselves now live in
// lib/plus/beachMode.ts so they can be tested without rendering this card.
export { AUTO_ARM_MS, shouldAutoArm };

/** True when a Live Activity start() ticket is no longer current — the armed
 *  session moved on (a later start, or an Off) before start() resolved.
 *  Wraps the same generation-ticket rule Beach Mode's own arm() uses (R-02);
 *  exported for testing. */
export function isStaleLiveActivityTicket(ticket: number, current: number): boolean {
  return !isCurrentArmTicket(ticket, current);
}

/** The identity of an armed session for Live Activity purposes: which beach,
 *  for which window. Retargeting (LOC-02, auto sessions follow the phone)
 *  can leave `armedUntil` unchanged — `extendArmedUntil` is a no-op when the
 *  window already has more time left than the new request — so `slug` alone
 *  isn't redundant with it; both must change identity. */
function laSessionIdentity(presence: { slug: string; armedUntil: number } | null): string | null {
  return presence ? `${presence.slug}|${presence.armedUntil}` : null;
}

/** Sentinel so the identity effect always fires its first run (mount
 *  included), even when the very first identity is `null` (not armed yet) —
 *  matches the ticket needing to be real before the first start(). */
const LA_SESSION_INIT = "__la_session_init__";

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

  // "Where you stand": only while ARMED with a fix that establishes arrival at
  // the MONITORED beach specifically (the same gate arm()/auto-arm use, not
  // just "near some beach") — a stale or coarse fix must never fetch a hazard
  // read it can't back.
  const armedTarget = presence ? beachOf(presence.slug) : null;
  const hazardsEligible = armed && establishesArrival(fix, armedTarget, Date.now());
  const hazards = useHazardsAtPoint({
    eligible: hazardsEligible,
    slug: presence?.slug ?? slug,
    fix,
    beaches,
    requestFresh,
  });
  const hazardLine = hazards ? beachModeHazardLine(hazards.point, hazards.beach) : null;

  // --- Beach Session Live Activity (docs/LIVE_ACTIVITY_PLAN.md Phase 2) -----
  //
  // One-time opt-in (`bd:live-activity`), then auto start/update/end mirrors
  // `armed`. Entirely additive to everything above: it never reads or writes
  // any of Beach Mode's own arm/disarm/hazard state, only observes it.
  const [laPref, setLaPref] = useState<"on" | "off" | null>(null);
  const [laPrefLoaded, setLaPrefLoaded] = useState(false);
  const [laAvailable, setLaAvailable] = useState(false);
  const laActivityIdRef = useRef<string | null>(null);
  const laSeqRef = useRef(0);
  const laLastHashRef = useRef<string | null>(null);
  const laLastUpdateAtRef = useRef(0);
  const laDismissedRef = useRef(false); // this session's activity was user-dismissed: no auto-recreate
  const laSessionStartRef = useRef<number | null>(null);
  const laStartingRef = useRef(false);
  // A ticket per armed SESSION IDENTITY (R-02, same rule as arm()'s
  // armSeqRef): bumped whenever `laSessionIdentity` changes — Off, a newer
  // session, or a same-window retarget to a different beach — so a start()
  // that resolves after the session it was for is already gone can tell it's
  // stale and undo itself instead of recording a runaway (or wrong-beach)
  // activity.
  const laSessionSeqRef = useRef(0);
  // The current session's identity, kept live in a ref so the activityState
  // listener (registered once, native-only) can key a persisted dismissal
  // off the CURRENT session without re-subscribing on every presence tick.
  const laIdentityRef = useRef<{ slug: string; armedUntil: number } | null>(null);
  // Distinct from any real identity (including `null`, meaning "not armed")
  // so the effect below always does its bump-and-teardown on the first run.
  const laSessionIdRef = useRef<string | null>(LA_SESSION_INIT);

  useEffect(() => {
    laIdentityRef.current = presence ? { slug: presence.slug, armedUntil: presence.armedUntil } : null;
  }, [presence]);

  useEffect(() => {
    setLaPref(readLiveActivityPref());
    setLaPrefLoaded(true);
  }, []);

  // Bump the session ticket, and tear down whatever activity belonged to the
  // PREVIOUS identity, whenever the armed session's identity changes: Off,
  // a newer session, or a same-window retarget (LOC-02's auto sessions
  // follow the phone) to a different beach. The immutable ActivityAttributes
  // can't retarget in place, so a retarget must end the old activity and let
  // the start/update effect below begin a fresh one for the new beach.
  // Mount is included (the sentinel never equals a real identity) so the
  // very first start() already has a real ticket to check itself against.
  useEffect(() => {
    const identity = armed ? laSessionIdentity(presence) : null;
    if (identity === laSessionIdRef.current) return;
    const hadPriorSession = laSessionIdRef.current !== LA_SESSION_INIT;
    laSessionIdRef.current = identity;
    laSessionSeqRef.current += 1;
    if (laActivityIdRef.current) {
      const id = laActivityIdRef.current;
      laActivityIdRef.current = null;
      void liveActivity.end(id, { dismissal: "immediate" });
    }
    laDismissedRef.current = false;
    laSessionStartRef.current = null;
    laLastHashRef.current = null;
    laSeqRef.current = 0;
    laStartingRef.current = false;
    if (hadPriorSession) writeLiveActivityDismissal(null); // previous session is over
  }, [armed, presence]);

  // A dismissal saved for THIS armed session (bd:live-activity-dismissed)
  // survives a remount that a plain ref can't — a backgrounded app or a
  // relaunch would otherwise recreate the exact activity the user just
  // swiped away on the Lock Screen. Keyed on the session's identity (beach +
  // window), not just the window, so a retarget doesn't inherit a dismissal
  // that belonged to the old beach.
  useEffect(() => {
    if (!armed || !presence) return;
    const saved = readLiveActivityDismissal();
    if (saved && saved.slug === presence.slug && saved.armedUntil === presence.armedUntil) {
      laDismissedRef.current = true;
    }
  }, [armed, presence]);

  // Reachability check: the plugin exists AND this device/OS currently allows
  // Live Activities (iOS 16.2+, not disabled in Settings). Re-checked each
  // time Beach Mode arms, since Settings can change between visits. Losing
  // native or entitlement must read as unavailable immediately, not linger
  // on whatever the last check said.
  useEffect(() => {
    if (!native || !plus.entitled) {
      setLaAvailable(false);
      return;
    }
    let alive = true;
    void liveActivity.getStatus().then((status) => {
      if (alive) setLaAvailable(status.enabled);
    });
    return () => {
      alive = false;
    };
  }, [native, plus.entitled, armed]);

  // Entitlement (or native availability) lost mid-session (expiry, refund,
  // server correction, Settings toggle): end whatever activity is running
  // rather than let a now-free/unavailable user keep a Plus-only Lock Screen
  // feature running. Also bumps the session ticket here — the same place
  // the activity is ended — so a start() already in flight when this fires
  // resolves stale: it can't pass the ticket check and record a Plus-only
  // activity after entitlement is gone.
  useEffect(() => {
    if (plus.entitled && laAvailable) return;
    laStartingRef.current = false;
    laSessionSeqRef.current += 1;
    if (laActivityIdRef.current) {
      const id = laActivityIdRef.current;
      laActivityIdRef.current = null;
      void liveActivity.end(id, { dismissal: "immediate" });
    }
  }, [plus.entitled, laAvailable]);

  // Native activity-state listener — dismissal suppresses auto-recreation for
  // the rest of this session (persisted, so it also survives a remount), but
  // never touches Beach Mode's own arm state.
  useEffect(() => {
    if (!native) return;
    return liveActivity.onActivityState((e) => {
      if (e.activityId !== laActivityIdRef.current) return;
      if (e.state === "dismissed") {
        laDismissedRef.current = true;
        laActivityIdRef.current = null;
        const identity = laIdentityRef.current;
        if (identity) writeLiveActivityDismissal({ slug: identity.slug, armedUntil: identity.armedUntil });
      }
    });
  }, [native]);

  const laTargetSlug = armed && armedTarget && plus.entitled ? armedTarget.slug : null;
  const { data: laConditions } = useSWR<ConditionsResponse>(
    laTargetSlug && laPref === "on" && laAvailable ? `/api/conditions/${laTargetSlug}` : null,
    conditionsFetcher,
    { refreshInterval: LIVE_ACTIVITY_MIN_UPDATE_MS, revalidateOnFocus: false },
  );

  const laShowPrompt = armed && laPrefLoaded && laAvailable && laPref === null;

  const laRespondToPrompt = useCallback((choice: "on" | "off") => {
    writeLiveActivityPref(choice);
    setLaPref(choice);
  }, []);

  // Off (armed -> not armed) is handled by the session-identity effect above,
  // which tears down and resets on ANY identity change, including this one.

  // Start / update from each fresh conditions read, throttled to at most one
  // bridge call per LIVE_ACTIVITY_MIN_UPDATE_MS and only when the mapped
  // state actually changed.
  useEffect(() => {
    if (!armed || laPref !== "on" || !laAvailable || !laConditions || !armedTarget || !plus.entitled) return;
    if (!plus.deviceId) return; // the plugin uploads its own token — it needs a device id to send with it
    if (laDismissedRef.current) return; // user dismissed it this session

    const state = contentStateFromConditions(laConditions, {
      nowMs: Date.now(),
      lightningPoint: hazards?.point ?? null,
    });
    const hash = hashContentState(state);

    if (!laActivityIdRef.current) {
      if (laStartingRef.current) return;
      laStartingRef.current = true;
      const sessionStart = laSessionStartRef.current ?? Date.now();
      laSessionStartRef.current = sessionStart;
      const seq = laSeqRef.current;
      const ticket = laSessionSeqRef.current;
      const wire: BeachSessionWireState = { ...state, v: 1, seq };
      // Round-2 #1(c): await the install-token bootstrap FIRST — most
      // devices have never had a reason to POST /api/devices before now
      // (that only otherwise fires on an actual profile/home/prefs edit),
      // so without this the very first Beach Mode session of a phone's
      // lifetime would call start() with nothing to send, and
      // liveActivity.start() itself now refuses to call the native plugin
      // with a null token (round-2 #1d) rather than let a doomed
      // /register upload go out. If this still comes back null — a lost
      // token this device isn't entitled to recover (round-2 #2), or
      // simply offline — this session reads as unavailable exactly like
      // `laAvailable` being false: nothing starts, nothing throws, and the
      // card renders its ordinary non-Live-Activity state. The staleness
      // ticket check below still applies after the await resolves.
      void plus.ensureInstallToken().then((installToken) => {
        if (!installToken || isStaleLiveActivityTicket(ticket, laSessionSeqRef.current)) {
          laStartingRef.current = false;
          return;
        }
        void liveActivity
          .start(
            { beachName: armedTarget.name, slug: armedTarget.slug, sessionStart },
            wire,
            plus.deviceId,
            LA_APP_BUILD,
          )
          .then((res) => {
            laStartingRef.current = false;
            if (!res.ok) return;
            if (isStaleLiveActivityTicket(ticket, laSessionSeqRef.current)) {
              // The armed session this was for is already gone (Off, or a
              // newer session started before this one resolved) — end what
              // we just started rather than record and leave it running.
              void liveActivity.end(res.activityId, { dismissal: "immediate" });
              return;
            }
            laActivityIdRef.current = res.activityId;
            laLastHashRef.current = hash;
            laLastUpdateAtRef.current = Date.now();
            laSeqRef.current = seq + 1;
          });
      });
      return;
    }

    const now = Date.now();
    if (hash === laLastHashRef.current) return; // nothing meaningful changed
    if (now - laLastUpdateAtRef.current < LIVE_ACTIVITY_MIN_UPDATE_MS) return;

    const seq = laSeqRef.current;
    const wire: BeachSessionWireState = { ...state, v: 1, seq };
    const id = laActivityIdRef.current;
    laLastHashRef.current = hash;
    laLastUpdateAtRef.current = now;
    laSeqRef.current = seq + 1;
    void liveActivity.update(id, wire);
    // hazards is read for its CURRENT value only when this effect runs (on a
    // fresh conditions poll) — it is not itself a trigger, so it is left out
    // of the dependency list on purpose (mirrors hazards' own eligibility
    // pattern elsewhere in this file, which re-reads live refs rather than
    // re-running on every hazards tick).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [armed, laPref, laAvailable, laConditions, armedTarget, plus.entitled, plus.deviceId]);

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
        {hazardLine ? (
          <p className="mt-1 text-xs leading-snug text-slate-500 dark:text-slate-400">{hazardLine}</p>
        ) : null}
        {laShowPrompt ? (
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
            <span className="min-w-0 flex-1 text-sm text-slate-700 dark:text-slate-300">
              Show a Beach Session on your Lock Screen while Beach Mode is on?
            </span>
            <div className="flex shrink-0 gap-2">
              <button type="button" onClick={() => laRespondToPrompt("on")} className={CHIP}>
                Yes
              </button>
              <button type="button" onClick={() => laRespondToPrompt("off")} className={CHIP}>
                No
              </button>
            </div>
          </div>
        ) : null}
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
