// When the sunrise/sunset COLOR score may be shown.
//
// Product rule (owner, 2026-10-15): the color score must never look like a
// prediction before we have an observation. The benchmark in
// docs/benchmarks/sun-leadtime-2026-10-15/REPORT.md found the forecast about 30
// points off and uncorrelated with what the cams saw at EVERY lead time. So
// outside a short window before the event the app shows NO number. It says when
// the forecast will be ready instead.
//
// The window opens SUN_FORECAST_WINDOW_MINUTES before the event and stays open
// through the event and everything after it (the card keeps tonight's sunset
// on screen until its golden window closes). Before the window opens the state
// is "pending"; from the first instant of the window on it is "available".
//
// Everything here is pure epoch math plus one Intl format call: no clock reads
// (`nowMs` is always passed in), no I/O. The window is plain subtraction on
// epoch milliseconds, so it is correct across local midnight and DST changes.
// Only the copy ("5:52 PM") is rendered in the beach's own time zone.
//
// Surfaces that obey this rule: the sun card (components/SunQualityCard.tsx),
// the share card tile (lib/shareCard.ts), the sun-color push alert
// (lib/alerts/sunColor.ts), the Plus day view's still-to-come events
// (lib/history/dayView.ts), and the watch + agent payloads
// (lib/watchView.ts, lib/agent/beachView.ts). The archive of past events keeps
// its stored score: that is a record, not a prediction.

import { fmtTime } from "@/lib/format";
import { nextSunEvent, type SunEventKind, type SunEventTimes } from "@/lib/sunQuality";

/** How long before the event the color score becomes visible. */
export const SUN_FORECAST_WINDOW_MINUTES = 60;
export const SUN_FORECAST_WINDOW_MS = SUN_FORECAST_WINDOW_MINUTES * 60_000;

export type SunForecastState = "available" | "pending";

export interface SunForecastWindow {
  state: SunForecastState;
  /** When the window opens: the event minus SUN_FORECAST_WINDOW_MINUTES (ISO, UTC). */
  availableAtIso: string;
  /** The event itself (ISO, UTC), echoed back as a valid instant. */
  eventIso: string;
}

/**
 * Is the color score for an event allowed on screen at `nowMs`?
 * "available" from `event - 60 min` onward (inclusive), "pending" before it.
 * Null when the event time is not a valid instant, so the caller shows nothing
 * rather than a guess.
 */
export function sunForecastWindow(eventIso: string | null | undefined, nowMs: number): SunForecastWindow | null {
  const eventMs = eventIso ? Date.parse(eventIso) : NaN;
  if (!Number.isFinite(eventMs) || !Number.isFinite(nowMs)) return null;
  const availableMs = eventMs - SUN_FORECAST_WINDOW_MS;
  return {
    state: nowMs >= availableMs ? "available" : "pending",
    availableAtIso: new Date(availableMs).toISOString(),
    eventIso: new Date(eventMs).toISOString(),
  };
}

/** True when the score may be shown (window open). False when pending OR the time is unreadable. */
export function sunForecastOpen(eventIso: string | null | undefined, nowMs: number): boolean {
  return sunForecastWindow(eventIso, nowMs)?.state === "available";
}

/** "Sunset" / "Sunrise". */
function eventWord(kind: SunEventKind): string {
  return kind === "sunrise" ? "Sunrise" : "Sunset";
}

/**
 * The pending copy: "Sunset forecast ready at 5:52 PM" / "Sunrise forecast ready at 6:19 AM".
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

/** The second line under the short form: "1 hour before sunset at 6:52 PM". */
export function sunForecastPendingWhy(kind: SunEventKind, eventIso: string, tz: string): string {
  return `${SUN_FORECAST_WINDOW_MINUTES / 60 === 1 ? "1 hour" : `${SUN_FORECAST_WINDOW_MINUTES} minutes`} before ${kind} at ${fmtTime(eventIso, tz)}`;
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
  /** "Sunset forecast ready at 5:52 PM" while pending, null once available. */
  text: string | null;
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
