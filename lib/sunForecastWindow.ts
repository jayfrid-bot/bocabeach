// When the sunrise/sunset score may be shown, and how firm it is.
//
// Product rule (owner, 2026-10-15): the score must never look like a prediction
// before we have an observation. Outside a window before the event the app
// shows NO number. It says when the forecast will be ready instead.
//
// Two steps since 2026-11-11 (docs/benchmarks/2026-11-11-sun-lead-time/REPORT.md):
//
//   1. The window OPENS SUN_FORECAST_WINDOW_MINUTES (120) before the event with
//      an EARLY LOOK: the mean of a satellite score and an hourly-forecast score
//      (lib/sunAlert.ts). On the cams it ranks skies as well as the one-hour
//      satellite score does, but about 1 in 4 early looks changes band by the
//      one-hour mark. So it carries the words "Early look".
//   2. It FIRMS UP SUN_FORECAST_FIRM_MINUTES (60) before the event: from then
//      on the score comes from the satellite alone, as it did before.
//
// The window stays open through the event and everything after it (the card
// keeps tonight's sunset on screen until its golden window closes). Before it
// opens the state is "pending"; from its first instant on it is "available",
// and `early` is true until the firm mark.
//
// Everything here is pure epoch math plus one Intl format call: no clock reads
// (`nowMs` is always passed in), no I/O. The window is plain subtraction on
// epoch milliseconds, so it is correct across local midnight and DST changes.
// Only the copy ("5:52 PM") is rendered in the beach's own time zone.
//
// Surfaces that show the early look: the sun card (components/SunQualityCard.tsx)
// and the share card tile (lib/shareCard.ts); the watch + agent payloads
// (lib/watchView.ts, lib/agent/beachView.ts) carry the state, never a score.
// Surfaces that wait for the firm mark: the sun push alert
// (lib/alerts/sunColor.ts) and the Plus day view's still-to-come events
// (lib/history/dayView.ts). The archive of past events keeps its stored score:
// that is a record, not a prediction.

import { fmtTime } from "@/lib/format";
import { nextSunEvent, type SunEventKind, type SunEventTimes } from "@/lib/sunQuality";

/** How long before the event the score becomes visible (the early look). */
export const SUN_FORECAST_WINDOW_MINUTES = 120;
export const SUN_FORECAST_WINDOW_MS = SUN_FORECAST_WINDOW_MINUTES * 60_000;
/** How long before the event the score firms up (satellite only; no "Early look" words). */
export const SUN_FORECAST_FIRM_MINUTES = 60;
export const SUN_FORECAST_FIRM_MS = SUN_FORECAST_FIRM_MINUTES * 60_000;

export type SunForecastState = "available" | "pending";

export interface SunForecastWindow {
  state: SunForecastState;
  /** When the window opens: the event minus SUN_FORECAST_WINDOW_MINUTES (ISO, UTC). */
  availableAtIso: string;
  /** The event itself (ISO, UTC), echoed back as a valid instant. */
  eventIso: string;
  /** True from the opening until the firm mark: the score on screen is the early look. */
  early: boolean;
  /** When the score firms up: the event minus SUN_FORECAST_FIRM_MINUTES (ISO, UTC). */
  firmAtIso: string;
}

/**
 * Is the score for an event allowed on screen at `nowMs`, and is it firm?
 * "available" from `event - 120 min` onward (inclusive), "pending" before it;
 * `early` until `event - 60 min`. Null when the event time is not a valid
 * instant, so the caller shows nothing rather than a guess.
 */
export function sunForecastWindow(eventIso: string | null | undefined, nowMs: number): SunForecastWindow | null {
  const eventMs = eventIso ? Date.parse(eventIso) : NaN;
  if (!Number.isFinite(eventMs) || !Number.isFinite(nowMs)) return null;
  const availableMs = eventMs - SUN_FORECAST_WINDOW_MS;
  const firmMs = eventMs - SUN_FORECAST_FIRM_MS;
  const open = nowMs >= availableMs;
  return {
    state: open ? "available" : "pending",
    availableAtIso: new Date(availableMs).toISOString(),
    eventIso: new Date(eventMs).toISOString(),
    early: open && nowMs < firmMs,
    firmAtIso: new Date(firmMs).toISOString(),
  };
}

/** True when the score may be shown (window open, early look included). False when pending OR the time is unreadable. */
export function sunForecastOpen(eventIso: string | null | undefined, nowMs: number): boolean {
  return sunForecastWindow(eventIso, nowMs)?.state === "available";
}

/** True only once the score has firmed up (the event is at most 60 min away, or past). */
export function sunForecastFirm(eventIso: string | null | undefined, nowMs: number): boolean {
  const w = sunForecastWindow(eventIso, nowMs);
  return !!w && w.state === "available" && !w.early;
}

/** "Sunset" / "Sunrise". */
function eventWord(kind: SunEventKind): string {
  return kind === "sunrise" ? "Sunrise" : "Sunset";
}

/**
 * The pending copy: "Sunset forecast ready at 4:52 PM" / "Sunrise forecast ready at 5:19 AM".
 * The time is when the forecast becomes available (event minus the window), in
 * the beach's own time zone, h:mm AM/PM. No score, no band word, no "/100".
 * Owner, 2026-10-18: the old "Sunset forecast at 5:52 PM" read like sunset was at 5:52, so the
 * line says the time is when the forecast is ready. Owner, same day: say "sunset forecast" /
 * "sunrise forecast", never "color forecast".
 */
export function sunForecastPendingText(kind: SunEventKind, availableAtIso: string, tz: string): string {
  return `${eventWord(kind)} forecast ready at ${fmtTime(availableAtIso, tz)}`;
}

/** The short form for the share card tile, whose label already names the event ("Sunset",
 *  "Sunrise tomorrow") and whose note must stay short: "Forecast ready at 5:52 PM". */
export function sunForecastPendingShort(availableAtIso: string, tz: string): string {
  return `Forecast ready at ${fmtTime(availableAtIso, tz)}`;
}

/** "2 hours" / "1 hour" / "90 minutes". */
function spanWords(minutes: number): string {
  if (minutes % 60 !== 0) return `${minutes} minutes`;
  return minutes === 60 ? "1 hour" : `${minutes / 60} hours`;
}

/** The second line under the short form: "2 hours before sunset at 6:52 PM". */
export function sunForecastPendingWhy(kind: SunEventKind, eventIso: string, tz: string): string {
  return `${spanWords(SUN_FORECAST_WINDOW_MINUTES)} before ${kind} at ${fmtTime(eventIso, tz)}`;
}

/** The words that go with an early-look score: "Early look. Firms up at 5:52 PM". */
export function sunForecastEarlyText(firmAtIso: string, tz: string): string {
  return `Early look. Firms up at ${fmtTime(firmAtIso, tz)}`;
}

/** The short form for tight spots (the share card tile): "Early look". */
export const SUN_FORECAST_EARLY_SHORT = "Early look";

/** One plain sentence on what an early look is, for the back of the card. */
export function sunForecastEarlyWhy(kind: SunEventKind): string {
  return `This is an early look, ${spanWords(SUN_FORECAST_WINDOW_MINUTES)} to ${spanWords(SUN_FORECAST_FIRM_MINUTES)} before the ${kind}. It mixes what the satellite sees now with the hourly forecast. About 1 in 4 early looks moves to another band by the time it firms up.`;
}

/** What the watch and agent payloads carry. `score` is never part of it: those
 *  surfaces show the state and the line only. When "available" the line is null. */
export interface SunForecastField {
  kind: SunEventKind;
  state: SunForecastState;
  /** When the window opens (ISO, UTC). */
  availableAt: string;
  /** The event the field is about (ISO, UTC). */
  eventAt: string;
  /** "Sunset forecast ready at 4:52 PM" while pending, null once available. */
  text: string | null;
  /** True while the forecast is open but still an early look (added 2026-11-11; older clients ignore it). */
  early: boolean;
  /** When the forecast firms up (ISO, UTC). */
  firmAt: string;
}

/** Build the payload field for one event. Null when the event time is unreadable. */
export function sunForecastField(
  kind: SunEventKind,
  eventIso: string | null | undefined,
  nowMs: number,
  tz: string,
): SunForecastField | null {
  const w = sunForecastWindow(eventIso, nowMs);
  if (!w) return null;
  return {
    kind,
    state: w.state,
    availableAt: w.availableAtIso,
    eventAt: w.eventIso,
    text: w.state === "pending" ? sunForecastPendingText(kind, w.availableAtIso, tz) : null,
    early: w.early,
    firmAt: w.firmAtIso,
  };
}

/** The slice of a snapshot's sun data the next-event pick reads. */
export interface SunForecastSunData {
  sunrise?: string;
  sunset?: string;
  tomorrowSunrise?: string;
}

/**
 * The payload field for the NEXT sunrise or sunset at a beach: today's sunrise
 * if it has not happened, else today's sunset, else tomorrow's sunrise (the
 * same pick as lib/sunQuality.ts's `nextSunEvent`, so after an event passes the
 * field rolls to the next one). Null with no usable sun times.
 */
export function nextSunForecastField(
  sun: SunForecastSunData | null | undefined,
  nowMs: number,
  tz: string,
): SunForecastField | null {
  if (!sun) return null;
  const today: SunEventTimes = { sunrise: sun.sunrise, sunset: sun.sunset };
  const next = nextSunEvent(new Date(nowMs), today, { sunriseIso: sun.tomorrowSunrise });
  return next ? sunForecastField(next.event, next.timeIso, nowMs, tz) : null;
}
