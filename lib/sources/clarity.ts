import type {
  CamWaterClarity,
  ClarityData,
  ClarityDaySummary,
  Location,
  WaterClarityGrade,
  Wrapped,
} from "@/lib/types";
import { clamp, fetchedAtOf, fetchWithTimeout, nowIso, oldestIso } from "@/lib/util";
import { fmtTime } from "@/lib/format";
import { fetchSun } from "@/lib/sources/sun";
// The overnight fallback ("what did the water look like on the last readable
// day, and when does the next read land?") is the same question busyness asks,
// so both cards share one implementation of day selection, day naming and the
// next-read instant. See lib/sources/busyness.ts.
import { camDayLabel, mostRecentReadableDay, nextCamReadIso } from "@/lib/sources/busyness";

const ATTRIBUTION = "Beach cams + Gemini vision";

/** Beyond this age, even a daytime capture is too stale to call "current". */
const STALE_CAPTURE_MS = 2 * 60 * 60_000;
/** Cams can only read the water in daylight — the readable local-hour window. */
const DAY_START_HOUR = 6;
const DAY_END_HOUR = 20;

const NIGHT_NOTE =
  "cams can't read the water in the dark — no live clarity reading overnight";
const STALE_NOTE =
  "latest cam capture is a couple hours old — clarity reading paused until a fresher shot comes in";
const NO_WATER_NOTE =
  "cams couldn't make out open water in the latest frame — no clarity reading right now";

// Worst-first: the murkier the water, the higher the rank (churned is worst).
const RANK: Record<WaterClarityGrade, number> = {
  clear: 0,
  slightly_murky: 1,
  murky: 2,
  churned: 3,
};

/** Same off-Netlify cam-vision job now publishes per-cam water-clarity reads here. */
const CAM_FEED_URL =
  process.env.CAM_SEAWEED_FEED_URL ??
  "https://raw.githubusercontent.com/jayfrid-bot/bocabeach/sargassum-data/cam_seaweed.json";

interface CamReading {
  id?: string;
  name?: string;
  /** null when this frame shows no open water (e.g. darkness). */
  water?: WaterClarityGrade | null;
  /** 0-100 clarity (100 = crystal clear); null when no open water. */
  waterPct?: number | null;
  waterNote?: string;
}
interface CamGroup {
  capturedAtLocal?: string;
  cams?: CamReading[];
}
/** A rolling raw cam read; the clarity fields (water/clr) are only on today-onward entries. */
interface HistoryEntry {
  t?: string;
  hour?: number;
  water?: WaterClarityGrade | null;
  clr?: number | null;
}
export interface ClarityFeed {
  /** When the off-Netlify job generated this snapshot (ISO) — the real freshness. */
  generatedAt?: string;
  latest?: CamGroup | null;
  morning?: CamGroup | null;
  history?: HistoryEntry[];
}

export interface ClarityGateOptions {
  /** Instant to evaluate the night/freshness gate against. Defaults to real now —
   *  pass an explicit value in tests for determinism. */
  now?: Date;
  /** IANA timezone for the local-hour night gate. Omit to skip the night gate
   *  (the stale-capture check still applies). */
  timezone?: string;
  /** Today's / tomorrow's sunrise (ISO) — only used to say when the next cam
   *  read lands. Omit to leave that line off. */
  sunriseIso?: string;
  tomorrowSunriseIso?: string;
  /** Today's calendar date at the beach (YYYY-MM-DD) — anchors "yesterday". */
  nowLocalDate?: string;
}

/** The local hour (0-23) of `date` in `tz`, or undefined if it can't be derived. */
function localHourInTz(date: Date, tz: string): number | undefined {
  const h = Number(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", hour12: false }).format(date),
  );
  return Number.isFinite(h) ? h % 24 : undefined;
}

/**
 * Why the current cam capture can't be trusted as a live clarity reading right
 * now, if any. Night (outside the local daylight window) always wins over a
 * stale-capture read, since a dark-frame read is nonsense regardless of age.
 * Mirrors lib/sources/busyness.ts's `unreadableReason`, but keyed to a fixed
 * local-hour window (6-20) rather than sun times.
 */
function unreadableReason(
  capturedAtLocal: string | undefined,
  opts: ClarityGateOptions,
): string | undefined {
  const now = opts.now ?? new Date();
  const nowMs = now.getTime();

  if (opts.timezone) {
    const hour = localHourInTz(now, opts.timezone);
    if (hour != null && (hour < DAY_START_HOUR || hour >= DAY_END_HOUR)) {
      return NIGHT_NOTE;
    }
  }

  if (capturedAtLocal) {
    const capturedMs = new Date(capturedAtLocal).getTime();
    if (Number.isFinite(capturedMs) && nowMs - capturedMs > STALE_CAPTURE_MS) {
      return STALE_NOTE;
    }
  }

  return undefined;
}

const clampPct = (n: number): number => Math.max(0, Math.min(100, Math.round(n)));

/**
 * Positively-framed display word for water clarity. The underlying vision
 * model still grades on the same four-step scale (clear / slightly_murky /
 * murky / churned) — this only changes the WORD shown to a beachgoer, deriving
 * it from the clarity percentage when one is present so "65% clear" reads as
 * "Mostly clear" instead of a discouraging "slightly murky".
 *
 * Band mapping (percentage is 0-100, 100 = crystal clear):
 *   >= 85            "Crystal clear"
 *   65-84            "Mostly clear"
 *   45-64            "A bit murky"
 *   25-44            "Murky"
 *   < 25             "Very murky" (or "Churned up" when the grade itself is
 *                    "churned" — a stirred-up read, not just cloudy)
 *
 * Falls back to a positively-adjusted word for the categorical grade alone
 * when no percentage is available:
 *   clear → "Clear", slightly_murky → "Mostly clear", murky → "Murky",
 *   churned → "Churned up".
 */
export function clarityDisplayWord(
  level: WaterClarityGrade | null | undefined,
  pct: number | null | undefined,
): string {
  if (pct != null) {
    if (pct >= 85) return "Crystal clear";
    if (pct >= 65) return "Mostly clear";
    if (pct >= 45) return "A bit murky";
    if (pct >= 25) return "Murky";
    return level === "churned" ? "Churned up" : "Very murky";
  }
  switch (level) {
    case "clear":
      return "Clear";
    case "slightly_murky":
      return "Mostly clear";
    case "murky":
      return "Murky";
    case "churned":
      return "Churned up";
    default:
      return "";
  }
}

// --- Overnight fallback: the last readable day's water ---------------------

/** Median of a non-empty list; even counts take the rounded mean of the middle
 *  two, exactly like the live cross-cam median above. */
function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2] : Math.round((s[n / 2 - 1] + s[n / 2]) / 2);
}

/**
 * The last readable day's water clarity, for the card to show while the live
 * read is night-gated or stale: the day's median clarity and its display word,
 * plus the morning and afternoon medians when the day has reads on both sides
 * of noon (mornings are often the clear half). Null when no day carries enough
 * daylight reads. Pure + tested.
 */
export function clarityDaySummary(
  history: readonly HistoryEntry[],
  todayLocal?: string,
): ClarityDaySummary | null {
  const day = mostRecentReadableDay(
    history,
    todayLocal,
    (e) => typeof e.clr === "number" && Number.isFinite(e.clr),
  );
  if (!day) return null;

  const reads = day.entries.map((e) => ({
    hour: e.hour as number,
    pct: clampPct(clamp(e.clr as number, 0, 100)),
    water: e.water ?? null,
  }));
  const pct = median(reads.map((r) => r.pct));
  // The grade word comes from the read closest to the median, mirroring how the
  // live headline picks its cam — so picture and percentage never disagree.
  const closest = reads.reduce((a, b) =>
    Math.abs(b.pct - pct) < Math.abs(a.pct - pct) ? b : a,
  );

  const am = reads.filter((r) => r.hour < 12).map((r) => r.pct);
  const pm = reads.filter((r) => r.hour >= 12).map((r) => r.pct);
  const bothHalves = am.length > 0 && pm.length > 0;

  return {
    dateLocal: day.dateLocal,
    dayLabel: camDayLabel(day.dateLocal, todayLocal),
    pct,
    word: clarityDisplayWord(closest.water, pct),
    ...(bothHalves ? { amPct: median(am), pmPct: median(pm) } : {}),
    reads: reads.length,
  };
}

/** True when the feed actually carries clarity fields (vs a legacy pre-clarity feed). */
function hasClarityFields(feed: ClarityFeed): boolean {
  const groups = [feed?.latest, feed?.morning];
  for (const g of groups) {
    for (const c of g?.cams ?? []) {
      if (c && "water" in c) return true;
    }
  }
  for (const e of feed?.history ?? []) {
    if (e && ("water" in e || "clr" in e)) return true;
  }
  return false;
}

/**
 * Roll the per-cam water-clarity reads into one grade: the MEDIAN across the
 * cams of the most recent capture.
 *
 * CALIBRATED 2026-07-24 against owner in-water ground truth: the cams read
 * 25/65/85 while the owner (swimming at Boca that minute) estimated 75% clear.
 * The previous worst-of rule published 25 — one angle contaminated by floating
 * seaweed patches (a separate, already-tracked signal) dragged the whole
 * reading down. Per-angle clarity noise is mostly DOWNWARD (seaweed patches,
 * sun glare, whitewater), so worst-of systematically under-reads; the median
 * (65 that tick) landed within 10 pts of truth. See docs/CLARITY_CALIBRATION.md.
 * Pure + tested.
 *
 * Returns null when the feed carries no clarity fields at all (a legacy /
 * pre-clarity feed) so the caller reports an honest "unavailable" rather than a
 * fabricated reading. When a capture exists but is night-gated, stale, or showed
 * no open water, returns a level-null ClarityData carrying the reason.
 */
export function summarizeClarity(
  feed: ClarityFeed,
  gate?: ClarityGateOptions,
): ClarityData | null {
  // A pre-clarity feed (fields not published yet) → unavailable, not a fake read.
  if (!hasClarityFields(feed)) return null;

  const group = feed?.latest ?? feed?.morning ?? undefined;
  const capturedAtLocal = group?.capturedAtLocal;

  // Night / stale gate (only when the caller opts in) — degrade to a level-null
  // "unknown" reading with the reason, mirroring busyness.
  const note = gate ? unreadableReason(capturedAtLocal, gate) : undefined;
  if (note) {
    // Gated: still an honest no-live-read (level null, status "unknown"), with
    // the last readable day and the next read time attached for the card.
    return {
      level: null,
      pct: null,
      note,
      capturedAtLocal,
      status: "unknown",
      yesterday: clarityDaySummary(feed?.history ?? [], gate?.nowLocalDate),
      // Night has a knowable end; a stale or no-open-water daytime frame does
      // not, so those keep their own note rather than promising a sunrise.
      nextReadIso:
        note === NIGHT_NOTE
          ? nextCamReadIso(gate?.now ?? new Date(), gate?.sunriseIso, gate?.tomorrowSunriseIso)
          : undefined,
    };
  }

  // Only cams that actually saw open water (water is a valid grade, not null).
  const perCam: CamWaterClarity[] = (group?.cams ?? [])
    .filter(
      (c): c is CamReading & { water: WaterClarityGrade } =>
        !!c && typeof c.water === "string" && c.water in RANK,
    )
    .map((c) => ({
      id: c.id,
      name: c.name ?? "cam",
      water: c.water,
      waterPct: typeof c.waterPct === "number" ? clampPct(c.waterPct) : null,
      waterNote: c.waterNote,
    }));

  if (!perCam.length) {
    // Capture exists but no cam could read open water (e.g. darkness) — honest
    // "no reading" rather than pretending the water is clear.
    return { level: null, pct: null, note: NO_WATER_NOTE, capturedAtLocal, status: "unknown" };
  }

  // MEDIAN across the cams (see the calibration note above). Prefer the numeric
  // clarity %s; the categorical level + note come from the cam closest to the
  // median % (or the median-ranked grade when no cam reported a %).
  const withPct = perCam.filter((c) => c.waterPct != null);
  if (withPct.length) {
    const pcts = withPct.map((c) => c.waterPct as number).sort((a, b) => a - b);
    const n = pcts.length;
    const med =
      n % 2 ? pcts[(n - 1) / 2] : Math.round((pcts[n / 2 - 1] + pcts[n / 2]) / 2);
    const closest = withPct.reduce((a, b) =>
      Math.abs((b.waterPct as number) - med) < Math.abs((a.waterPct as number) - med) ? b : a,
    );
    return {
      level: closest.water,
      pct: med,
      note: closest.waterNote,
      capturedAtLocal,
      perCam,
    };
  }
  const ranked = [...perCam].sort((a, b) => RANK[a.water!] - RANK[b.water!]);
  const mid = ranked[Math.floor(ranked.length / 2)];
  return {
    level: mid.water,
    pct: mid.waterPct,
    note: mid.waterNote,
    capturedAtLocal,
    perCam,
  };
}

/** Exactly what the Water clarity tile renders — the copy decision in one pure,
 *  tested place instead of inside the dashboard's JSX. */
export interface ClarityTileCopy {
  /** Headline word ("Mostly clear", or "Yesterday: Mostly clear" at night). */
  value: string;
  /** Supporting line: the %, the note, and when the next cam read lands. */
  sub: string;
  /** What the water-column scene should draw (null = no scene). */
  pct: number | null;
  level?: WaterClarityGrade | null;
  /** True when the scene is showing a past day, not a live read — the tile
   *  dims it so a remembered reading never looks like a current one. */
  muted?: boolean;
  /** Phone-width variant of `sub`: the deterministic parts only (no free-text
   *  cam note), so a 2-column tile never has to truncate mid-sentence. */
  subShort?: string;
}

const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
/** Only call out the AM/PM split when the halves actually differed. */
const HALF_DAY_GAP_PTS = 10;

/**
 * Copy for the Water clarity tile. Three cases:
 *  - a live read → the reading, as before;
 *  - gated with a readable day behind us → that day's word and %, dimmed, plus
 *    when the cams look again ("Yesterday: Mostly clear · ~72% clear · next cam
 *    read ~6:40 AM") — the overnight answer the owner asked for;
 *  - gated with nothing behind us (a brand-new beach) → the honest note plus
 *    the next read time.
 */
export function clarityTileCopy(d: ClarityData, tz: string): ClarityTileCopy {
  const nextRead = d.nextReadIso ? `next cam read ~${fmtTime(d.nextReadIso, tz)}` : null;

  if (d.level) {
    return {
      value: clarityDisplayWord(d.level, d.pct),
      sub: [
        d.pct != null ? `~${d.pct}% clear` : null,
        d.note,
        d.capturedAtLocal ? `as of ${fmtTime(d.capturedAtLocal, tz)}` : null,
      ]
        .filter(Boolean)
        .join(" · "),
      subShort: [
        d.pct != null ? `~${d.pct}% clear` : null,
        d.capturedAtLocal ? `as of ${fmtTime(d.capturedAtLocal, tz)}` : null,
      ]
        .filter(Boolean)
        .join(" · "),
      pct: d.pct,
      level: d.level,
    };
  }

  const y = d.yesterday;
  if (y) {
    const split =
      y.amPct != null && y.pmPct != null && Math.abs(y.amPct - y.pmPct) >= HALF_DAY_GAP_PTS
        ? `${y.amPct}% AM, ${y.pmPct}% PM`
        : null;
    return {
      value: `${cap(y.dayLabel)}: ${y.word}`,
      // Closes with when the cams look again — or, for a daytime outage (which
      // has no knowable end, so no nextReadIso), the reason they're out.
      sub: [`~${y.pct}% clear`, split, nextRead ?? d.note].filter(Boolean).join(" · "),
      pct: y.pct,
      muted: true,
    };
  }

  return {
    value: "—",
    sub: [d.note ?? "not available", nextRead].filter(Boolean).join(" · "),
    pct: null,
  };
}

export async function fetchClarity(loc: Location): Promise<Wrapped<ClarityData>> {
  // Water clarity (Tier 1) is read from the same cam-vision job, which only
  // covers beaches with configured cams (currently just Boca). For a cam-less
  // beach there's no clarity source here — return no data so the UI hides the
  // card instead of showing another beach's reading. (Satellite nearshore
  // clarity for cam-less beaches is a planned Tier 2.)
  if (!loc.cams?.length) {
    return {
      source: ATTRIBUTION,
      status: "best-effort",
      fetchedAt: nowIso(),
      attribution: ATTRIBUTION,
      data: null,
      note: "no beach cams here — water clarity isn't tracked for this beach",
    };
  }
  let fetchedAt = nowIso();
  try {
    const res = await fetchWithTimeout(CAM_FEED_URL, {
      timeoutMs: 7000,
      next: { revalidate: 600 }, // 10 min — same feed/cache as busyness + seaweed (deduped)
    });
    fetchedAt = fetchedAtOf(res);
    if (res.status === 404) {
      return {
        source: ATTRIBUTION,
        status: "best-effort",
        fetchedAt,
        attribution: ATTRIBUTION,
        data: null,
        note: "cam feed not published yet",
      };
    }
    if (!res.ok) throw new Error(`cam clarity feed -> ${res.status}`);
    const feed = (await res.json()) as ClarityFeed;
    // The GitHub CDN's Date header is serve-time, not when the job generated the
    // snapshot — report the older of the two so RelativeTime matches the card.
    fetchedAt = oldestIso(feed.generatedAt, fetchedAtOf(res));
    // Sun times are a pure local computation (no network) — they only answer
    // "when does the next cam read land?"; the night gate itself still runs off
    // the fixed local-hour window above.
    const sun = fetchSun(loc).data;
    const data = summarizeClarity(feed, {
      timezone: loc.timezone,
      sunriseIso: sun?.sunrise,
      tomorrowSunriseIso: sun?.tomorrowSunrise,
      // Today's calendar date at the BEACH, so "yesterday" means the beach's
      // yesterday and not the server's.
      nowLocalDate: new Intl.DateTimeFormat("en-CA", { timeZone: loc.timezone }).format(new Date()),
    });
    return {
      source: ATTRIBUTION,
      status: data && data.level ? "ok" : "best-effort",
      fetchedAt,
      attribution: ATTRIBUTION,
      data,
      note: data ? undefined : "water clarity not published yet",
    };
  } catch (e) {
    return {
      source: ATTRIBUTION,
      status: "error",
      fetchedAt,
      attribution: ATTRIBUTION,
      data: null,
      note: String(e),
    };
  }
}
