// Thin bridge wrapper around the native `BeachSessionActivity` Capacitor
// plugin (ios/App/App/BeachSessionActivityPlugin.swift). Mirrors
// lib/push/native.ts's resolver shape and its documented `.then` trap:
//
//   CRITICAL: getPlugin() below is SYNCHRONOUS. Never `await`, `Promise.race`,
//   or `Promise.resolve` its return value directly — only the Promises its
//   METHODS return. Capacitor's plugin proxy traps every property access,
//   including `.then`, as a native call; awaiting the proxy itself routes to
//   a non-existent native "then" method that never resolves, hanging forever.
//
// This is a purely local (non-npm) plugin, so unlike PushNotifications there
// is no bundled `@capacitor/*` import to fall back to — it only exists via
// the WebView's injected `window.Capacitor` bridge. Off-native (a normal
// browser, or a native build where the plugin didn't register) every export
// here degrades to an inert "not available" result; nothing throws.

import type { BeachSessionContentState } from "@/lib/liveActivity/state";
import { readInstallToken } from "@/lib/plus/storage";

/** ContentState.v this bridge speaks — bump only when adding a field, per
 *  ios/App/Shared/BeachSessionAttributes.swift's versioning rule. */
export const CONTENT_STATE_VERSION = 1;

/** The wire shape sent to `start`/`update` — ContentState plus the two
 *  fields lib/liveActivity/state.ts deliberately leaves to the caller
 *  because they're about update sequencing, not derived from conditions. */
export type BeachSessionWireState = BeachSessionContentState & {
  v: number;
  seq: number;
  ended?: boolean;
};

export interface BeachSessionAttributesWire {
  beachName: string;
  slug: string;
  /** Epoch ms. */
  sessionStart: number;
}

export type Dismissal = "immediate" | "default";

export type BridgeResult<T extends object = Record<string, never>> =
  | ({ ok: true } & T)
  | { ok: false; reason: string };

export interface ActivityStatusEntry {
  id: string;
  state: BeachSessionWireState;
}

export interface ActivityStatus {
  enabled: boolean;
  activities: ActivityStatusEntry[];
}

export interface PushTokenEvent {
  activityId: string;
  /** Never logged by native; treat as a bearer credential here too. */
  token: string;
}

export interface ActivityStateEvent {
  activityId: string;
  /** e.g. "active" | "dismissed" | "ended" | "stale" — whatever ActivityKit's
   *  own `ActivityState` maps to; Phase 3 is the only consumer that needs to
   *  branch on more than "dismissed". */
  state: string;
}

interface BeachSessionActivityPlugin {
  start(opts: {
    attributes: BeachSessionAttributesWire;
    state: BeachSessionWireState;
    deviceId: string;
    /** Codex review #1: the plugin keeps this per activity (Keychain) and
     *  sends it as `x-install-token` on its own /register + /end uploads —
     *  the WebView JS can be dead when either happens. `null` when this
     *  phone hasn't been issued one yet (a fresh install that hasn't called
     *  POST /api/devices, or lost local storage); the native side's own
     *  upload then goes without the header, same as any other caller with no
     *  token on file. */
    installToken: string | null;
    appBuild?: string;
  }): Promise<BridgeResult<{ activityId: string }>>;
  update(opts: { activityId: string; state: BeachSessionWireState }): Promise<BridgeResult>;
  end(opts: { activityId: string; finalState?: BeachSessionWireState; dismissal: Dismissal }): Promise<BridgeResult>;
  getStatus(): Promise<ActivityStatus>;
  addListener(
    eventName: "pushToken",
    listener: (event: PushTokenEvent) => void,
  ): Promise<{ remove: () => void }>;
  addListener(
    eventName: "activityState",
    listener: (event: ActivityStateEvent) => void,
  ): Promise<{ remove: () => void }>;
}

/** The native-injected bridge global, when present. Same rationale as
 *  lib/push/native.ts's `nativeBridge()`: this is the object that actually
 *  talks to the native side on the remote-URL shell. */
function nativeBridge(): {
  isPluginAvailable?: (n: string) => boolean;
  Plugins?: { BeachSessionActivity?: BeachSessionActivityPlugin };
} | null {
  if (typeof window === "undefined") return null;
  const cap = (
    window as unknown as {
      Capacitor?: {
        isPluginAvailable?: (n: string) => boolean;
        Plugins?: { BeachSessionActivity?: BeachSessionActivityPlugin };
      };
    }
  ).Capacitor;
  return cap ?? null;
}

/**
 * Resolve the plugin SYNCHRONOUSLY, or null when it isn't available (any
 * browser, or a native build predating this plugin). Never await this
 * return value itself — see the module comment.
 */
function getPlugin(): BeachSessionActivityPlugin | null {
  const bridge = nativeBridge();
  if (!bridge) return null;
  if (bridge.isPluginAvailable && !bridge.isPluginAvailable("BeachSessionActivity")) return null;
  return bridge.Plugins?.BeachSessionActivity ?? null;
}

/** True only when the plugin is reachable at all (native build has it
 *  registered). Does NOT mean Live Activities are enabled on this device —
 *  call getStatus() for that. */
export function isAvailable(): boolean {
  return getPlugin() != null;
}

function unavailable(): { ok: false; reason: string } {
  return { ok: false, reason: "BeachSessionActivity plugin not available" };
}

/** Ends any existing BeachSession activity first (native enforces "one active
 *  session per device") and starts a new one. `deviceId` (the app's
 *  `bd:device-id`) and an optional `appBuild` are kept by the plugin itself,
 *  per activity, so it can upload a rotated push token or report a Lock
 *  Screen dismissal to the server on its own — the WebView JS can be dead
 *  when either happens (docs/LIVE_ACTIVITY_PLAN.md Phase 3). Fail-soft: a
 *  bridge error never throws, it resolves `{ok:false, reason}` — the card
 *  must render exactly as if Live Activities were simply off. */
export async function start(
  attributes: BeachSessionAttributesWire,
  state: BeachSessionWireState,
  deviceId: string,
  appBuild?: string,
): Promise<BridgeResult<{ activityId: string }>> {
  const plugin = getPlugin();
  if (!plugin) return unavailable();
  // Round-2 #1(d): never hand the native side a null installToken. The
  // plugin's own /register upload requires the header once this device has
  // a hash on file (app/api/live-activity/register/route.ts), so starting
  // without one is guaranteed to 401 server-side anyway — failing here,
  // before spending an ActivityKit activity and a native round trip on a
  // request that can't succeed, is strictly better. The CALLER
  // (usePlus/BeachModeCard) is expected to have already awaited
  // `ensureInstallToken()` before calling this — see lib/plus/client.ts —
  // so in the ordinary path this branch is never hit; it exists as the
  // second line of defense for a caller that forgot.
  const installToken = readInstallToken();
  if (!installToken) return { ok: false, reason: "no install token" };
  try {
    return await plugin.start({ attributes, state, deviceId, installToken, appBuild });
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : "start failed" };
  }
}

export async function update(activityId: string, state: BeachSessionWireState): Promise<BridgeResult> {
  const plugin = getPlugin();
  if (!plugin) return unavailable();
  try {
    return await plugin.update({ activityId, state });
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : "update failed" };
  }
}

export async function end(
  activityId: string,
  opts: { finalState?: BeachSessionWireState; dismissal: Dismissal },
): Promise<BridgeResult> {
  const plugin = getPlugin();
  if (!plugin) return unavailable();
  try {
    return await plugin.end({ activityId, finalState: opts.finalState, dismissal: opts.dismissal });
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : "end failed" };
  }
}

/** Never throws — an unreachable plugin reads as "disabled, no activities",
 *  which is exactly how the card should treat it. */
export async function getStatus(): Promise<ActivityStatus> {
  const plugin = getPlugin();
  if (!plugin) return { enabled: false, activities: [] };
  try {
    return await plugin.getStatus();
  } catch {
    return { enabled: false, activities: [] };
  }
}

/** Subscribe to native push-token rotations for the activity's lifetime.
 *  Phase 3 (server token registration) is the real consumer; Phase 2 only
 *  wires the listener so it exists and can be inspected/tested. Returns a
 *  no-op unsubscribe when the plugin isn't available. */
export function onPushToken(listener: (event: PushTokenEvent) => void): () => void {
  const plugin = getPlugin();
  if (!plugin) return () => {};
  let handle: { remove: () => void } | null = null;
  void plugin
    .addListener("pushToken", listener)
    .then((h) => {
      handle = h;
    })
    .catch(() => {});
  return () => handle?.remove();
}

/** Subscribe to native activity-state changes (dismissal, etc). Returns a
 *  no-op unsubscribe when the plugin isn't available. */
export function onActivityState(listener: (event: ActivityStateEvent) => void): () => void {
  const plugin = getPlugin();
  if (!plugin) return () => {};
  let handle: { remove: () => void } | null = null;
  void plugin
    .addListener("activityState", listener)
    .then((h) => {
      handle = h;
    })
    .catch(() => {});
  return () => handle?.remove();
}
