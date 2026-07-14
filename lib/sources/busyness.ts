import type {
  BusynessByDay,
  BusynessByHour,
  BusynessData,
  BusynessLevel,
  Location,
  Wrapped,
} from "@/lib/types";
import { fetchedAtOf, fetchWithTimeout, nowIso, oldestIso } from "@/lib/util";
import { fetchSun } from "@/lib/sources/sun";

const ATTRIBUTION = "Beach cams + Gemini vision";

/** How far past sunset / before sunrise the cams are still considered readable. */
const DAYLIGHT_BUFFER_MS = 30 * 60_000;
/** Beyond this age, even a daytime capture is too stale to call "current". */
const STALE_CAPTURE_MS = 3 * 60 * 60_000;

const NIGHT_NOTE =
  "cams can't read the beach in the dark — no live busyness reading overnight";
const STALE_NOTE =
  "latest cam capture is a few hours old — busyness reading paused until a fresher shot comes in";

export interface BusynessGateOptions {
  /** Instant to evaluate daylight/freshness against. Defaults to real now — pass
   * an explicit value in tests for determinism. */
  now?: Date;
  /** Today's sunrise/sunset instants (ISO). Omit to skip the daylight gate
   * (e.g. sun data unavailable) — the stale-capture check still applies. */
  sunriseIso?: string;
  sunsetIso?: string;
}

/**
 * Why the current cam capture can't be trusted as a live busyness reading right
 * now, if any. Night (outside sunrise/sunset ± a buffer) always wins over a
 * stale-capture read, since a dark-frame read is nonsense regardless of age.
 */
function unreadableReason(
  capturedAtLocal: string | undefined,
  opts: BusynessGateOptions,
): string | undefined {
  const now = opts.now ?? new Date();
  const nowMs = now.getTime();

  if (opts.sunriseIso && opts.sunsetIso) {
    const sunriseMs = new Date(opts.sunriseIso).getTime();
    const sunsetMs = new Date(opts.sunsetIso).getTime();
    if (Number.isFinite(sunriseMs) && Number.isFinite(sunsetMs)) {
      if (nowMs < sunriseMs - DAYLIGHT_BUFFER_MS || nowMs > sunsetMs + DAYLIGHT_BUFFER_MS) {
        return NIGHT_NOTE;
      }
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

/** Same off-Netlify cam-vision job publishes per-cam crowd reads here. */
const CAM_FEED_URL =
  process.env.CAM_SEAWEED_FEED_URL ??
  "https://raw.githubusercontent.com/jayfrid-bot/bocabeach/sargassum-data/cam_seaweed.json";

const RANK: Record<string, number> = {
  empty: 0,
  quiet: 1,
  moderate: 2,
  busy: 3,
  packed: 4,
};

interface CamReading {
  name: string;
  crowd?: string;
  people?: number;
  crowdPct?: number;
  crowdNote?: string;
}
interface CamGroup {
  capturedAtLocal?: string;
  cams?: CamReading[];
}
interface HistoryEntry {
  t?: string; // local capture time, ISO (the date prefix drives the by-day chart)
  hour?: number;
  level?: string; // busiest crowd at this capture
  people?: number;
  crowdPct?: number; // 0-100 fullness at the busiest cam
}
export interface CamFeed {
  /** When the off-Netlify job generated this snapshot (ISO) — the real freshness. */
  generatedAt?: string;
  latest?: CamGroup | null;
  morning?: CamGroup | null;
  history?: HistoryEntry[];
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const LEVELS: BusynessLevel[] = ["empty", "quiet", "moderate", "busy", "packed"];

/** Average the rolling history into a typical busyness per local hour. */
function byHourFromHistory(history: HistoryEntry[]): BusynessByHour[] | undefined {
  const buckets = new Map<
    number,
    { rank: number; people: number; pN: number; pct: number; cN: number; n: number }
  >();
  for (const e of history) {
    if (typeof e.hour !== "number" || typeof e.level !== "string" || !(e.level in RANK)) {
      continue;
    }
    const b = buckets.get(e.hour) ?? { rank: 0, people: 0, pN: 0, pct: 0, cN: 0, n: 0 };
    b.rank += RANK[e.level];
    b.n += 1;
    if (typeof e.people === "number") {
      b.people += e.people;
      b.pN += 1;
    }
    if (typeof e.crowdPct === "number") {
      b.pct += e.crowdPct;
      b.cN += 1;
    }
    buckets.set(e.hour, b);
  }
  if (!buckets.size) return undefined;
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([hour, b]) => ({
      hour,
      level: LEVELS[Math.round(b.rank / b.n)],
      people: b.pN ? Math.round(b.people / b.pN) : undefined,
      crowdPct: b.cN ? Math.round(b.pct / b.cN) : undefined,
      // Granular height: fullness-aware when we have a crowd %, else the level rank.
      avg: Math.round((b.cN ? pctToRank(b.pct / b.cN) : b.rank / b.n) * 100) / 100,
      samples: b.n,
    }));
}

// Map a measured fullness % (0-100) to a continuous 0-4 crowd rank, using the
// crowd band boundaries (empty<10, quiet<30, moderate<55, busy<80, packed).
function pctToRank(pct: number): number {
  const c = Math.max(0, Math.min(100, pct));
  if (c < 10) return c / 10; // empty -> quiet
  if (c < 30) return 1 + (c - 10) / 20; // quiet -> moderate
  if (c < 55) return 2 + (c - 30) / 25; // moderate -> busy
  if (c < 80) return 3 + (c - 55) / 25; // busy -> packed
  return 4;
}

/** One read's crowd rank (0-4): the measured fullness when present, else category. */
function readRank(e: HistoryEntry): number | undefined {
  if (typeof e.crowdPct === "number" && Number.isFinite(e.crowdPct)) return pctToRank(e.crowdPct);
  if (typeof e.level === "string" && e.level in RANK) return RANK[e.level];
  return undefined;
}

/**
 * Average each day's busyness from the rolling history (not the single peak), so
 * days compare fairly regardless of how many reads they got. Each read uses its
 * measured fullness % when present, else its category; the bar height is the
 * day's AVERAGE level, the colour is that average rounded to a band, plus the
 * day's average people estimate for the tooltip.
 */
function byDayFromHistory(history: HistoryEntry[]): BusynessByDay[] | undefined {
  const byDate = new Map<string, { sum: number; n: number; people: number; pN: number }>();
  for (const e of history) {
    if (typeof e.t !== "string") continue;
    const r = readRank(e);
    if (r === undefined) continue;
    const date = e.t.slice(0, 10);
    if (!DATE_RE.test(date)) continue;
    const b = byDate.get(date) ?? { sum: 0, n: 0, people: 0, pN: 0 };
    b.sum += r;
    b.n += 1;
    if (typeof e.people === "number") {
      b.people += e.people;
      b.pN += 1;
    }
    byDate.set(date, b);
  }
  if (!byDate.size) return undefined;
  return [...byDate.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, b]) => {
      const avg = b.sum / b.n;
      return {
        date,
        avg: Math.round(avg * 100) / 100,
        level: LEVELS[Math.round(avg)],
        people: b.pN ? Math.round(b.people / b.pN) : undefined,
        samples: b.n,
      };
    });
}

/**
 * Roll up the per-cam crowd reads into one busyness level. Uses the LATEST
 * capture (busyness is time-of-day dependent, unlike seaweed) and takes the
 * busiest cam as the headline. Pure (unit-tested); `gate` is how the caller
 * (fetchBusyness) tells it whether "now" is outside daylight or the capture
 * is stale — both cases degrade the CURRENT reading to "unknown" (no
 * level/people/crowdPct headline) while leaving the historical byHour/byDay
 * charts untouched, since those are daytime aggregates that stay valid.
 */
export function summarizeBusyness(feed: CamFeed, gate?: BusynessGateOptions): BusynessData {
  const byHour = byHourFromHistory(feed?.history ?? []);
  const byDay = byDayFromHistory(feed?.history ?? []);
  const group = feed?.latest ?? feed?.morning ?? undefined;

  // No gate passed at all -> caller isn't opting into the daylight/freshness
  // check (e.g. tests exercising cam-selection logic in isolation); only
  // fetchBusyness's real callers pass one.
  const note = gate ? unreadableReason(group?.capturedAtLocal, gate) : undefined;
  if (note) {
    return { level: "unknown", capturedAtLocal: group?.capturedAtLocal, note, byHour, byDay };
  }

  const cams = (group?.cams ?? []).filter(
    (c): c is CamReading & { crowd: BusynessLevel } =>
      !!c && typeof c.crowd === "string" && c.crowd in RANK,
  );
  if (!cams.length) {
    return { level: "unknown", capturedAtLocal: group?.capturedAtLocal, byHour, byDay };
  }
  const busiest = cams.reduce((a, b) => {
    if (RANK[b.crowd] !== RANK[a.crowd]) return RANK[b.crowd] > RANK[a.crowd] ? b : a;
    return (b.crowdPct ?? -1) > (a.crowdPct ?? -1) ? b : a;
  });
  return {
    level: busiest.crowd,
    peopleEstimate: typeof busiest.people === "number" ? busiest.people : undefined,
    crowdPct: typeof busiest.crowdPct === "number" ? busiest.crowdPct : undefined,
    note: busiest.crowdNote,
    capturedAtLocal: group?.capturedAtLocal,
    cams: cams.map((c) => ({ name: c.name, crowd: c.crowd, people: c.people })),
    byHour,
    byDay,
  };
}

export async function fetchBusyness(
  loc: Location,
): Promise<Wrapped<BusynessData>> {
  // Crowd/busyness comes from the same cam-vision job — cam beaches only.
  // Without cams there is no crowd source here; return no data so the UI hides
  // it instead of showing another beach's (Boca's) crowd reading.
  if (!loc.cams?.length) {
    return {
      source: ATTRIBUTION,
      status: "best-effort",
      fetchedAt: nowIso(),
      attribution: ATTRIBUTION,
      data: null,
      note: "no beach cams here — crowd isn't tracked for this beach",
    };
  }
  let fetchedAt = nowIso();
  try {
    const res = await fetchWithTimeout(CAM_FEED_URL, {
      timeoutMs: 6000,
      next: { revalidate: 3600 }, // 1h — the cam-vision job runs a few times/day
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
    if (!res.ok) throw new Error(`cam feed -> ${res.status}`);
    const feed = (await res.json()) as CamFeed;
    // The GitHub CDN's Date header is serve-time, not when the job generated the
    // snapshot — report the older of the two so RelativeTime matches the card.
    fetchedAt = oldestIso(feed.generatedAt, fetchedAtOf(res));
    // Sun times are a pure local computation (no network) — cheap to derive here
    // so summarizeBusyness can gate the current reading to the beach's own
    // daylight window without depending on lib/conditions.ts's fetch ordering.
    const sun = fetchSun(loc).data;
    const data = summarizeBusyness(feed, { sunriseIso: sun?.sunrise, sunsetIso: sun?.sunset });
    return {
      source: ATTRIBUTION,
      status: data.level === "unknown" ? "best-effort" : "ok",
      fetchedAt,
      attribution: ATTRIBUTION,
      data,
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
