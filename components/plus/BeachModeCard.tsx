"use client";

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
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
import type { ActivityStatus, BeachSessionWireState } from "@/lib/plus/liveActivity";
import type { BeachSessionContentState } from "@/lib/liveActivity/state";
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

/** What to do with getStatus()'s answer, on mount (or whenever the armed
 *  session identity becomes known): adopt whatever activity is already
 *  running instead of blindly starting a new one. Native start() always ends
 *  the currently-running activity first (one-active-session-per-device), so
 *  starting here when one is already up — e.g. after the app's own
 *  auto-reload on a fresh deploy while Beach Mode was still armed — would
 *  flicker/restart the Lock Screen activity and leave a real registration
 *  gap while it does. Pulled out as a pure function of getStatus()'s result
 *  so the adopt decision is unit-testable without rendering this card (this
 *  file's other hook-driven effects follow the same untested-by-design
 *  convention noted in lib/plus/beachMode.ts's header). */
export function resolveLiveActivityAdoption(
  status: ActivityStatus,
): { activityId: string; nextSeq: number; content: BeachSessionContentState } | null {
  const running = status.activities[0];
  if (!running) return null;
  const { seq, ...content } = running.state;
  return { activityId: running.id, nextSeq: seq + 1, content };
}

export type LiveActivityStartDecision = "start" | "update" | "wait" | "abort";

/**
 * What the start/update effect should do at each point it could otherwise
 * blindly call start() over an activity that is — or is about to be —
 * already running. Adoption (`resolveLiveActivityAdoption` above) runs its
 * own getStatus() round trip asynchronously, so there is a window where the
 * start effect could fire in the same flush before that check has settled;
 * this is the single pure decision reused at every point in the start path
 * that could otherwise race it, regardless of which one settles first:
 *
 *  - BEFORE beginning start(): the adoption check for the current session
 *    identity may still be in flight (`adoptionChecked: false`) — wait
 *    rather than risk starting a second activity over one about to be
 *    adopted.
 *  - AFTER each await in the start path (ensureInstallToken, then the
 *    native start() call itself): adoption may have finished and recorded
 *    an activity id WHILE this call was in flight — switch to updating it
 *    instead of (or as well as) starting a new one.
 *
 * Testable both orders: adoption-resolves-first (hasActivityId already true
 * when the start effect's own gate check runs) and start-begins-first
 * (hasActivityId flips true only later, discovered on a post-await recheck).
 */
export function decideLiveActivityStart(opts: {
  /** This ticket/session is no longer current (Off, retarget, a newer
   *  session) — whatever this call was doing is moot. */
  stale: boolean;
  /** The adoption check (getStatus()) for the CURRENT session identity has
   *  resolved. Only meaningful for the BEFORE-start gate; a post-await
   *  recheck mid-flight is always past that point (adoption having already
   *  run, or being irrelevant off the adoption path) so it should pass
   *  `true` here. */
  adoptionChecked: boolean;
  /** An activity id is already recorded — adopted, or a start()/another
   *  await-recheck already won the race. */
  hasActivityId: boolean;
}): LiveActivityStartDecision {
  if (opts.stale) return "abort";
  if (opts.hasActivityId) return "update";
  if (!opts.adoptionChecked) return "wait";
  return "start";
}

/**
 * Whether an armed session identity is eligible for adoption (Codex
 * round-4): only the FIRST real identity a mount ever observes — a reload or
 * relaunch while Beach Mode was already armed, where a Live Activity can be
 * running from before this JS context existed. Every identity AFTER that
 * (retarget, Off→On again, a newer session) is a transition the
 * identity-teardown effect itself drives: it already ends whatever activity
 * belonged to the previous identity, so there is nothing left over from
 * OUTSIDE this session to adopt — only a race against that very end() call,
 * since getStatus()'s answer carries no slug/window to tell sessions apart
 * and could see the activity still "running" mid-teardown.
 */
export function isFirstArmedIdentityEligibleForAdoption(
  identity: string | null,
  hadPriorRealIdentity: boolean,
): boolean {
  return identity !== null && !hadPriorRealIdentity;
}

// --- Lock Screen row (the compact "Lock Screen: on/off" control inside the
// armed card) -----------------------------------------------------------
//
// Bug this fixes: the old one-time prompt only ever rendered while
// `laPref === null` AND the plugin read as available at that exact moment.
// Once a user answered — or once availability happened to read false on the
// one check the old effect ran (tied to `armed`, never re-checked) — the
// card fell silent forever: no way to see the pref, and no way to change it.
// This row is shown any time the card is armed, native, and entitled, in
// every state, so the control is never simply gone.

/** iOS major.minor, parsed from `navigator.userAgent` (e.g. "iPhone OS 18_0
 *  like Mac OS X" -> {major:18, minor:0}). `null` when the UA carries no
 *  recognizable "iPhone OS" token — the row then falls back to whatever the
 *  native plugin itself reports (`osEnabled`) instead of guessing a version
 *  it can't read. */
export interface IOSVersion {
  major: number;
  minor: number;
}

export function parseIOSMajorMinor(userAgent: string): IOSVersion | null {
  const m = /iPhone OS (\d+)_(\d+)/.exec(userAgent);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]) };
}

function iosAtLeast16_2(v: IOSVersion): boolean {
  return v.major > 16 || (v.major === 16 && v.minor >= 2);
}

/** What the Lock Screen row should show, and why — pure so every branch is
 *  unit-testable without rendering the card. Checked in order: plugin
 *  reachable at all, then the phone's own iOS version (this bridge's UA
 *  parse, independent of whatever native reports), then the native
 *  Settings toggle (`getStatus().enabled`) — matching the three distinct
 *  reasons a phone can fail to show a Beach Session. An unparseable iOS
 *  version (`iosMajorMinor: null`) skips straight to asking the plugin
 *  rather than being treated as "too old". */
export type LockScreenRowState =
  | { kind: "hidden" }
  | { kind: "prompt" }
  | { kind: "on"; running: boolean }
  | { kind: "off" }
  | {
      kind: "unavailable";
      reason: "plugin-missing" | "ios-too-old" | "os-disabled";
      message: string;
    };

export function lockScreenRowState(opts: {
  native: boolean;
  entitled: boolean;
  armed: boolean;
  pluginAvailable: boolean;
  osEnabled: boolean;
  iosMajorMinor: IOSVersion | null;
  pref: "on" | "off" | null;
  running: boolean;
}): LockScreenRowState {
  const { native, entitled, armed, pluginAvailable, osEnabled, iosMajorMinor, pref, running } = opts;
  if (!native || !entitled || !armed) return { kind: "hidden" };

  if (!pluginAvailable) {
    return {
      kind: "unavailable",
      reason: "plugin-missing",
      message: "Update the app to show this on your Lock Screen.",
    };
  }
  if (iosMajorMinor && !iosAtLeast16_2(iosMajorMinor)) {
    return { kind: "unavailable", reason: "ios-too-old", message: "Needs iOS 16.2 or later." };
  }
  if (!osEnabled) {
    return {
      kind: "unavailable",
      reason: "os-disabled",
      message:
        "Live Activities are off for this app — turn them on in iPhone Settings → Is It Beach Day → Live Activities.",
    };
  }
  if (pref === null) return { kind: "prompt" };
  return pref === "on" ? { kind: "on", running } : { kind: "off" };
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
  const [laReshowTick, setLaReshowTick] = useState(0); // bumped by Turn on / Show again to re-run the start effect
  const laSessionStartRef = useRef<number | null>(null);
  const laStartingRef = useRef(false);
  // Codex round-4: the identity-teardown effect below fires end() without
  // awaiting it (React effects can't be async). Stashing the promise here
  // lets the start path wait for that end() to actually settle before
  // calling native start() on a retarget — without it, start() (or worse,
  // adoption's getStatus(), which carries no slug/window to tell activities
  // apart) can see the old activity still "running" mid-teardown.
  const laPendingEndRef = useRef<Promise<unknown> | null>(null);
  // Codex review: serializes every native start()/update()/end() call this
  // card makes (lib/plus/liveActivity.ts's createSerialQueue) so the plugin
  // always sees them strictly one at a time, in the order they were queued.
  // The race this closes: Off then On fired quickly while a start() is
  // still in flight — the tickets above decide that stale call should undo
  // itself, but without ordering its cleanup end() can land AFTER the
  // newer start() and end the wrong activity. One queue instance per card
  // (lazy ref init: `useRef(fn)` would otherwise build a throwaway queue on
  // every render).
  const laQueueRef = useRef<ReturnType<typeof liveActivity.createSerialQueue> | null>(null);
  if (!laQueueRef.current) laQueueRef.current = liveActivity.createSerialQueue();
  const laSerial = useCallback(<T,>(fn: () => Promise<T>): Promise<T> => laQueueRef.current!(fn), []);
  // Render-visible status (the Lock Screen row) must not depend on refs
  // alone: laActivityIdRef/laDismissedRef are written from async callbacks
  // (a native listener, a start() resolving) that otherwise cause no
  // re-render of their own — the row would then show "Showing" after a
  // swipe-away, or "Off" long after Turn on actually succeeded, until some
  // UNRELATED prop happened to re-render this component. Called at every
  // site that writes either ref outside of a state update that already
  // re-renders on its own.
  const [, bumpLaUi] = useReducer((n: number) => n + 1, 0);
  // The single armed-session identity (see `laSessionIdentity`) eligible for
  // adoption: only the FIRST one observed after mount (a reload/relaunch
  // while already armed — see the identity-teardown effect below, which is
  // the only place this is set). Every later identity change (retarget,
  // Off→On again, a newer session) is entirely JS-driven: that same effect
  // already ends whatever activity belonged to the previous identity itself,
  // so there is nothing left over from outside this session to adopt —
  // only a race against the end() call it just fired (Codex round-4).
  const laAdoptionEligibleRef = useRef(false);
  const laHadPriorRealIdentityRef = useRef(false);
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
    // Codex round-4: adoption is only ever eligible for the FIRST real
    // identity this mount observes (a reload while already armed) — every
    // identity after that is a transition THIS effect itself drives, so it
    // both ends the old activity (nothing external left to adopt) and marks
    // itself ineligible for the new one, before the adoption effect (which
    // runs later in this same commit) gets a chance to check.
    laAdoptionEligibleRef.current = isFirstArmedIdentityEligibleForAdoption(identity, laHadPriorRealIdentityRef.current);
    if (identity !== null) laHadPriorRealIdentityRef.current = true;
    if (laActivityIdRef.current) {
      const id = laActivityIdRef.current;
      laActivityIdRef.current = null;
      const endPromise = laSerial(() => liveActivity.end(id, { dismissal: "immediate" }));
      laPendingEndRef.current = endPromise;
      void endPromise.finally(() => {
        if (laPendingEndRef.current === endPromise) laPendingEndRef.current = null;
      });
    }
    laDismissedRef.current = false;
    laSessionStartRef.current = null;
    laLastHashRef.current = null;
    laSeqRef.current = 0;
    laStartingRef.current = false;
    bumpLaUi(); // laActivityIdRef and/or laDismissedRef may have just changed
    if (hadPriorSession) writeLiveActivityDismissal(null); // previous session is over
  }, [armed, presence, laSerial]);

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
      bumpLaUi();
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
    const check = () => {
      void liveActivity.getStatus().then((status) => {
        if (alive) setLaAvailable(status.enabled);
      });
    };
    check();
    // Flipping Settings -> Is It Beach Day -> Live Activities fires no event
    // of its own — only returning to the app does. Re-check then so the Lock
    // Screen row updates on its own, without needing Beach Mode to re-arm.
    const onVisible = () => {
      if (document.visibilityState === "visible") check();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("pageshow", check);
    return () => {
      alive = false;
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("pageshow", check);
    };
  }, [native, plus.entitled, armed]);

  // Adopt an already-running Live Activity instead of starting a new one.
  // getStatus() (called just above to resolve `laAvailable`) can report an
  // activity from a PREVIOUS mount of this card — e.g. the app's own
  // auto-reload on a fresh deploy while Beach Mode was still armed. Native
  // start() always ends whatever activity is currently running before it
  // begins a new one (one-active-session-per-device), so if the start/update
  // effect below were left to run its ordinary `!laActivityIdRef.current` ->
  // start() path here, it would restart the SAME session's activity: a
  // flicker on the Lock Screen and a real registration gap while the old
  // activity is torn down and the new one spun up. Adopting instead means
  // setting `laActivityIdRef` (and the seq/hash refs) from whatever is
  // already running, so the start/update effect's existing `update()` branch
  // takes over on its very next tick — no start() call at all.
  //
  // Runs once per armed session identity (the same `laSessionIdentity` key
  // the teardown effect above uses), mount included. A retarget (identity
  // change) is unaffected: the teardown effect ends the old activity and
  // resets `laActivityIdRef` to null first, so this effect's own
  // `laActivityIdRef.current` guard lets the start/update effect start a
  // fresh activity for the new identity exactly as before.
  //
  // Two refs, not one (Codex round-2 #1): `laAdoptionAttemptedForRef` is set
  // SYNCHRONOUSLY, before the getStatus() await, purely to stop a re-render
  // firing a second concurrent check for the same identity.
  // `laAdoptionCheckedForRef` is set only once that check has SETTLED
  // (adopted, nothing to adopt, or mooted by a stale ticket) — the
  // start/update effect below gates on this one via `decideLiveActivityStart`
  // so it can never fire start() while an adoption check for the current
  // identity is still in flight.
  const laAdoptionAttemptedForRef = useRef<string | null>(null);
  const laAdoptionCheckedForRef = useRef<string | null>(null);
  // Codex round-3: `laAdoptionCheckedForRef` alone can't wake the
  // start/update effect below — a ref write causes no re-render, so a
  // "wait" decision there would sit until something UNRELATED happened to
  // re-render this component (could be minutes). This tick is bumped every
  // time the ref settles, purely to force that re-render; the ref (not the
  // tick's value) stays the actual source of truth the effects read.
  const [laAdoptionTick, setLaAdoptionTick] = useState(0);
  useEffect(() => {
    if (!native || !armed || !presence || !laAvailable || !plus.entitled) return;
    const identity = laSessionIdentity(presence);
    if (identity === null) return;
    if (laAdoptionAttemptedForRef.current === identity) return; // already checking/checked this session
    laAdoptionAttemptedForRef.current = identity;
    if (laActivityIdRef.current || !laAdoptionEligibleRef.current) {
      // Either already have one (started or adopted) — nothing to check —
      // or (Codex round-4) this isn't the first armed identity since mount:
      // a retarget/re-arm is entirely JS-driven, so the identity-teardown
      // effect already ended whatever activity belonged to the PREVIOUS
      // identity itself. Calling getStatus() here anyway would just race
      // that in-flight end() — its answer carries no slug/window, so it
      // could see the activity still "running" mid-teardown and adopt the
      // very one about to disappear. Mark checked immediately instead; the
      // existing end-then-start retarget path (below, awaiting
      // `laPendingEndRef`) is what actually gets this session a fresh
      // activity.
      laAdoptionCheckedForRef.current = identity;
      setLaAdoptionTick((n) => n + 1);
      return;
    }
    const ticket = laSessionSeqRef.current;
    // Only the still-current identity may settle its own adoption gate. A late
    // answer for an identity the phone has already left must not overwrite the
    // newer identity's "checked" marker (that would leave its start waiting).
    const stillCurrent = () =>
      !isStaleLiveActivityTicket(ticket, laSessionSeqRef.current) &&
      laSessionIdRef.current === identity;
    const settle = () => {
      if (!stillCurrent()) return;
      laAdoptionCheckedForRef.current = identity;
      setLaAdoptionTick((n) => n + 1);
    };
    void liveActivity.getStatus().then((status) => {
      try {
        // The session moved on (Off, retarget, a newer session) while this
        // was in flight — the teardown effect already handled it, and this
        // identity's check is moot (the NEW identity gets its own check).
        if (isStaleLiveActivityTicket(ticket, laSessionSeqRef.current)) return;
        if (laActivityIdRef.current) return; // start() beat us to it
        const adoption = resolveLiveActivityAdoption(status);
        if (!adoption) return; // nothing running — the ordinary start() path applies
        laActivityIdRef.current = adoption.activityId;
        laSessionStartRef.current = laSessionStartRef.current ?? Date.now();
        laLastHashRef.current = hashContentState(adoption.content);
        laSeqRef.current = adoption.nextSeq;
        // Force the next genuinely-changed conditions read through
        // immediately rather than waiting out a throttle window measured
        // from before this card even mounted.
        laLastUpdateAtRef.current = 0;
        bumpLaUi(); // adopted an already-running activity — "running" just became true
      } finally {
        // Resolved, errored, or the plugin was simply unreachable — either
        // way the check for this identity is done; mark it so the
        // start/update effect stops waiting even if there was nothing (or
        // nothing new) to adopt. The tick bump is what actually wakes that
        // effect (a plain ref write triggers no re-render on its own).
        settle();
      }
    }, settle);
  }, [native, armed, presence, laAvailable, plus.entitled]);

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
      bumpLaUi();
      void laSerial(() => liveActivity.end(id, { dismissal: "immediate" }));
    }
  }, [plus.entitled, laAvailable, laSerial]);

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
        bumpLaUi(); // a native event callback — nothing else re-renders this
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

  const laRespondToPrompt = useCallback((choice: "on" | "off") => {
    writeLiveActivityPref(choice);
    setLaPref(choice);
  }, []);

  // Reachability the OS/Settings answer (`laAvailable`, re-checked above)
  // can't distinguish on its own: whether the native plugin exists at all,
  // and whether this phone's iOS is even new enough for Live Activities.
  // Both are static for the life of this page load, so read them directly
  // rather than duplicate them in state.
  const laPluginAvailable = liveActivity.isAvailable();
  const laIosVersion = useMemo(
    () => (typeof navigator === "undefined" ? null : parseIOSMajorMinor(navigator.userAgent)),
    [],
  );

  const laTurnOff = useCallback(() => {
    writeLiveActivityPref("off");
    setLaPref("off");
    // Same ticket the identity-teardown effect bumps on Off/retarget (R-02):
    // invalidates any start()/update() already in flight for this session,
    // so it recognizes itself as stale on its next check and ends whatever
    // it just started, instead of resurrecting the activity the user just
    // turned off.
    laSessionSeqRef.current += 1;
    laStartingRef.current = false;
    if (laActivityIdRef.current) {
      const id = laActivityIdRef.current;
      laActivityIdRef.current = null;
      void laSerial(() => liveActivity.end(id, { dismissal: "immediate" }));
    }
  }, [laSerial]);

  const laTurnOn = useCallback(() => {
    writeLiveActivityPref("on");
    setLaPref("on");
    // An explicit "Turn on" / "Show again" overrides an earlier swipe-away on
    // the Lock Screen: without this the start effect keeps honoring that
    // dismissal and the tap would do nothing until Beach Mode re-arms.
    laDismissedRef.current = false;
    writeLiveActivityDismissal(null);
    setLaReshowTick((t) => t + 1);
    // No start() call here: flipping the pref back to "on" is all the
    // start/update effect below needs to begin a fresh activity — adoption
    // for this session identity has already settled.
  }, []);

  const laRow = lockScreenRowState({
    native,
    entitled: plus.entitled,
    armed,
    pluginAvailable: laPluginAvailable,
    osEnabled: laAvailable,
    iosMajorMinor: laIosVersion,
    pref: laPref,
    running: laActivityIdRef.current !== null,
  });

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

    // Codex round-2 #1: the adoption check above (getStatus(), for THIS
    // session identity) is async, so this effect can fire in the same flush
    // before it has settled — proceeding to start() here regardless would
    // let native start() end the very activity adoption was about to hand
    // us. `decideLiveActivityStart` is the single gate, reused again after
    // every await below in case adoption (or a previous tick of this same
    // effect) wins the race WHILE one of those awaits is in flight.
    const identity = laSessionIdentity(presence);
    const initialDecision = decideLiveActivityStart({
      stale: false,
      adoptionChecked: identity !== null && laAdoptionCheckedForRef.current === identity,
      hasActivityId: !!laActivityIdRef.current,
    });

    if (initialDecision === "wait") return; // adoption check for this identity still in flight

    if (initialDecision === "update") {
      const now = Date.now();
      if (hash === laLastHashRef.current) return; // nothing meaningful changed
      if (now - laLastUpdateAtRef.current < LIVE_ACTIVITY_MIN_UPDATE_MS) return;
      const seq = laSeqRef.current;
      const wire: BeachSessionWireState = { ...state, v: 1, seq };
      const id = laActivityIdRef.current!;
      laLastHashRef.current = hash;
      laLastUpdateAtRef.current = now;
      laSeqRef.current = seq + 1;
      void laSerial(() => liveActivity.update(id, wire));
      return;
    }

    // initialDecision === "start"
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
    // card renders its ordinary non-Live-Activity state.
    void plus.ensureInstallToken().then(async (installToken) => {
      // Recheck (Codex round-2 #1): adoption may have resolved and recorded
      // an activity id WHILE this await was in flight — switch to updating
      // it instead of starting a second one. `adoptionChecked: true` here
      // because this call is past the gate above regardless of outcome; the
      // only question left is the race, which `hasActivityId` answers.
      const decision = decideLiveActivityStart({
        stale: isStaleLiveActivityTicket(ticket, laSessionSeqRef.current),
        adoptionChecked: true,
        hasActivityId: !!laActivityIdRef.current,
      });
      if (decision === "abort") {
        laStartingRef.current = false;
        return;
      }
      if (decision === "update") {
        laStartingRef.current = false;
        // Capture the id NOW, synchronously — laActivityIdRef can be
        // cleared by a later effect (Off, entitlement loss) before this
        // queued call actually reaches the front of the line.
        const id = laActivityIdRef.current!;
        void laSerial(() => liveActivity.update(id, wire));
        laLastHashRef.current = hash;
        laLastUpdateAtRef.current = Date.now();
        laSeqRef.current = seq + 1;
        return;
      }
      // decision === "start": still need a token to actually call native
      // start() (update() above doesn't need one — only the /register
      // upload does).
      if (!installToken) {
        laStartingRef.current = false;
        return;
      }
      // Codex round-4: on a retarget, the identity-teardown effect fired
      // end(oldId) without awaiting it (effects can't be async) — native
      // enforces one activity per device, so calling start() before that
      // end() has actually settled risks it landing on top of (or racing)
      // the teardown. Wait for it here, then recheck once more: the ticket
      // could have gone stale, or (in principle) something else could have
      // recorded an activity id, while this settled.
      if (laPendingEndRef.current) {
        await laPendingEndRef.current.catch(() => {}); // never let a failed end() block start()
      }
      const postEndDecision = decideLiveActivityStart({
        stale: isStaleLiveActivityTicket(ticket, laSessionSeqRef.current),
        adoptionChecked: true,
        hasActivityId: !!laActivityIdRef.current,
      });
      if (postEndDecision === "abort") {
        laStartingRef.current = false;
        return;
      }
      if (postEndDecision === "update") {
        laStartingRef.current = false;
        // Same capture-before-enqueue reasoning as the branch above.
        const id = laActivityIdRef.current!;
        void laSerial(() => liveActivity.update(id, wire));
        laLastHashRef.current = hash;
        laLastUpdateAtRef.current = Date.now();
        laSeqRef.current = seq + 1;
        return;
      }
      void laSerial(() =>
        liveActivity.start(
          { beachName: armedTarget.name, slug: armedTarget.slug, sessionStart },
          wire,
          plus.deviceId,
          LA_APP_BUILD,
        ),
      ).then((res) => {
        laStartingRef.current = false;
        if (!res.ok) return;
        const postStartDecision = decideLiveActivityStart({
          stale: isStaleLiveActivityTicket(ticket, laSessionSeqRef.current),
          adoptionChecked: true,
          hasActivityId: !!laActivityIdRef.current,
        });
        if (postStartDecision !== "start") {
          // Either the armed session this was for is already gone (Off,
          // or a newer session started before this resolved), or adoption
          // (or another tick) already recorded a different activity id
          // while this native call was in flight — end what we just
          // started rather than record and leave a second one running.
          // Still queued: this end() must wait its turn behind whatever
          // else this card has since enqueued, same as every other call.
          void laSerial(() => liveActivity.end(res.activityId, { dismissal: "immediate" }));
          return;
        }
        laActivityIdRef.current = res.activityId;
        laLastHashRef.current = hash;
        laLastUpdateAtRef.current = Date.now();
        laSeqRef.current = seq + 1;
        bumpLaUi(); // the activity just started running — nothing else re-renders this
      });
    });
    // hazards is read for its CURRENT value only when this effect runs (on a
    // fresh conditions poll) — it is not itself a trigger, so it is left out
    // of the dependency list on purpose (mirrors hazards' own eligibility
    // pattern elsewhere in this file, which re-reads live refs rather than
    // re-running on every hazards tick). `presence` is read only for
    // `laSessionIdentity` above, which is otherwise already implied by
    // `armed`/`armedTarget` — also left out to avoid a redundant re-run on
    // every presence tick within the same identity. `laAdoptionTick` IS
    // included (Codex round-3): it's the only thing that wakes this effect
    // once the adoption check settles — `laAdoptionCheckedForRef` is a plain
    // ref, so without this a "wait" decision below would otherwise sit
    // until some unrelated prop caused a re-render, stalling a genuine
    // start() for however long that takes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    armed,
    laPref,
    laAvailable,
    laConditions,
    armedTarget,
    plus.entitled,
    plus.deviceId,
    laAdoptionTick,
    laReshowTick,
    laSerial,
  ]);

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
        {laPrefLoaded && laRow.kind !== "hidden" ? (
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
            {laRow.kind === "prompt" ? (
              <>
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
              </>
            ) : null}
            {laRow.kind === "on" ? (
              <>
                <span className="min-w-0 flex-1 text-sm text-slate-700 dark:text-slate-300">
                  {laRow.running
                    ? "Showing on your Lock Screen."
                    : laDismissedRef.current
                      ? "Swiped off your Lock Screen."
                      : "Lock Screen: on."}
                </span>
                {!laRow.running && laDismissedRef.current ? (
                  <button type="button" onClick={laTurnOn} className={CHIP}>
                    Show again
                  </button>
                ) : null}
                <button type="button" onClick={laTurnOff} className={CHIP}>
                  Turn off
                </button>
              </>
            ) : null}
            {laRow.kind === "off" ? (
              <>
                <span className="min-w-0 flex-1 text-sm text-slate-700 dark:text-slate-300">Lock Screen: off.</span>
                <button type="button" onClick={laTurnOn} className={CHIP}>
                  Turn on
                </button>
              </>
            ) : null}
            {laRow.kind === "unavailable" ? (
              <span className="min-w-0 flex-1 text-xs leading-snug text-slate-500 dark:text-slate-400">
                {laRow.message}
              </span>
            ) : null}
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
