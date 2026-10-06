// Which sun event the sun-color card shows (and scores), as pure functions —
// extracted from components/SunQualityCard.tsx so the card and the history
// archiver (lib/history/sunPredictions.ts) use ONE selection rule and can
// never drift. The card keeps an event on screen until its elevation-derived
// golden window CLOSES (see lib/goldenHourTiming.ts): between sunset and the
// window's end the card still shows tonight's sunset even though the plain
// `nextSunEvent` has already moved on to tomorrow's sunrise.
//
// Pure: no I/O, no clock reads (`now` is always passed in).

import {
  goldenHourTiming,
  type GoldenHourTiming,
  type GoldenHourTimingArgs,
  type GoldenTarget,
  type GoldenWindowInput,
} from "@/lib/goldenHourTiming";
import {
  GOLDEN_HOUR_MINUTES,
  nextSunEvent,
  type GoldenWindowIso,
  type SunEventKind,
  type SunEventTime,
} from "@/lib/sunQuality";

/** Today's sun times + real elevation windows (the card's `today` prop). */
export interface CardToday {
  sunrise?: string;
  sunset?: string;
  goldenAm?: GoldenWindowIso;
  goldenEve?: GoldenWindowIso;
}
/** Tomorrow's sunrise + its morning window (the card's `tomorrow` prop). */
export interface CardTomorrow {
  sunriseIso?: string;
  goldenAm?: GoldenWindowIso;
}

/** The card's ISO windows in the shape lib/goldenHourTiming.ts wants. Undefined
 *  when the snapshot didn't carry that elevation window. */
export function toWindow(w: GoldenWindowIso | undefined): GoldenWindowInput | undefined {
  if (!w?.goldenStartIso || !w.goldenEndIso) return undefined;
  return { start: w.goldenStartIso, end: w.goldenEndIso, peakAnchorIso: w.peakAnchorIso };
}

/** The sun event a timing target is built around, in lib/sunQuality.ts's shape,
 *  so the color score and the flip back describe the window the front shows. */
export function targetEvent(target: GoldenTarget | null): SunEventTime | null {
  if (!target?.eventIso) return null;
  return {
    event: target.kind === "am" ? "sunrise" : "sunset",
    timeIso: target.eventIso,
    goldenStartIso: target.start.toISOString(),
    goldenEndIso: target.end.toISOString(),
    goldenFromElevation: true,
    peakAnchorIso: target.peakAnchorIso,
  };
}

/**
 * The card's timing + scored event for `nowD`. Exactly the logic that used to
 * live inline in SunQualityCard: real elevation windows when the snapshot
 * carries them (else the ±20-min fallback around `nextSunEvent`), the pinned
 * golden-hour timing, and `scored` — the event whose color the card shows.
 */
export function sunCardTiming(args: {
  nowD: Date;
  today: CardToday;
  tomorrow?: CardTomorrow;
  formatTime?: (d: Date) => string;
}): {
  next: SunEventTime | null;
  timingArgs: Omit<GoldenHourTimingArgs, "now">;
  pinned: GoldenHourTiming;
  scored: SunEventTime | null;
} {
  const { nowD, today, tomorrow, formatTime } = args;
  const next = nextSunEvent(nowD, today, tomorrow);
  const realWindows = { am: toWindow(today.goldenAm), eve: toWindow(today.goldenEve) };
  const hasReal = !!realWindows.am || !!realWindows.eve;
  const fallback: GoldenWindowInput | undefined = next
    ? { start: next.goldenStartIso, end: next.goldenEndIso, peakAnchorIso: next.peakAnchorIso }
    : undefined;
  const sunsetMs = today.sunset ? Date.parse(today.sunset) : Number.NaN;
  const fallbackIsTomorrow =
    !!next && next.event === "sunrise" && Number.isFinite(sunsetMs) && nowD.getTime() >= sunsetMs;

  const timingArgs = {
    windows: hasReal
      ? realWindows
      : fallbackIsTomorrow
        ? {}
        : next?.event === "sunrise"
          ? { am: fallback }
          : { eve: fallback },
    sunrise: today.sunrise,
    sunset: today.sunset,
    tomorrowAmWindow: hasReal
      ? toWindow(tomorrow?.goldenAm)
      : fallbackIsTomorrow
        ? fallback
        : undefined,
    tomorrowSunrise: tomorrow?.sunriseIso ?? (fallbackIsTomorrow ? next?.timeIso : undefined),
    formatTime,
  };

  const pinned = goldenHourTiming({ ...timingArgs, now: nowD });
  const scored = targetEvent(pinned.target) ?? next;
  return { next, timingArgs, pinned, scored };
}

/** A window for an event when the snapshot has no real one: ±20 min around it
 *  (the same fallback `nextSunEvent` builds). */
function fallbackWindow(eventIso: string | undefined): GoldenWindowInput | undefined {
  const t = eventIso ? Date.parse(eventIso) : NaN;
  if (!Number.isFinite(t)) return undefined;
  const side = GOLDEN_HOUR_MINUTES * 60_000;
  return { start: new Date(t - side).toISOString(), end: new Date(t + side).toISOString() };
}

/**
 * The event of one KIND the card's rule would show at `nowD`: today's sunrise
 * or sunset until its golden window has closed (so the post-event part of golden
 * hour still points at the event on screen), else the next day's. This is the
 * card's own selection (`goldenHourTiming`'s "inside, else soonest upcoming
 * window") restricted to one side, so for the side the card is showing the two
 * always agree. `tomorrow` supplies the next day's event + window; `null` when
 * the needed times are missing.
 */
export function cardSunEventForKind(args: {
  kind: SunEventKind;
  nowD: Date;
  today: CardToday;
  /** Tomorrow's same-kind event: its time and golden window. */
  tomorrow?: { eventIso?: string; golden?: GoldenWindowIso };
}): SunEventTime | null {
  const { kind, nowD, today, tomorrow } = args;
  const isAm = kind === "sunrise";
  const eventIso = isAm ? today.sunrise : today.sunset;
  const todayWindow = (isAm ? toWindow(today.goldenAm) : toWindow(today.goldenEve)) ?? fallbackWindow(eventIso);
  const tomorrowWindow = toWindow(tomorrow?.golden) ?? fallbackWindow(tomorrow?.eventIso);

  // Use the card's own timing engine for "is today's window still open/ahead?".
  const timing = goldenHourTiming({
    now: nowD,
    windows: isAm ? { am: todayWindow } : { eve: todayWindow },
    sunrise: isAm ? eventIso : undefined,
    sunset: isAm ? undefined : eventIso,
    tomorrowAmWindow: isAm ? tomorrowWindow : undefined,
    tomorrowSunrise: isAm ? tomorrow?.eventIso : undefined,
  });
  const fromTiming = targetEvent(timing.target);
  if (fromTiming) return fromTiming;

  // Today's window is over and goldenHourTiming only looks ahead to tomorrow's
  // MORNING window — so for a sunset, step to tomorrow's by hand.
  if (!isAm && tomorrow?.eventIso && tomorrowWindow) {
    return {
      event: "sunset",
      timeIso: tomorrow.eventIso,
      goldenStartIso: String(tomorrowWindow.start),
      goldenEndIso: String(tomorrowWindow.end),
      goldenFromElevation: !!toWindow(tomorrow.golden),
      peakAnchorIso: tomorrowWindow.peakAnchorIso,
    };
  }
  return null;
}
