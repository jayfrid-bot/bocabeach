import type {
  CamWaterClarity,
  ClarityData,
  Location,
  WaterClarityGrade,
  Wrapped,
} from "@/lib/types";
import { fetchedAtOf, fetchWithTimeout, nowIso, oldestIso } from "@/lib/util";

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
 * Roll the per-cam water-clarity reads into one grade: the WORST cam of the most
 * recent capture (murkiest wins — one churned cam means the water isn't clear).
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
    return { level: null, pct: null, note, capturedAtLocal, status: "unknown" };
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

  // Worst (murkiest) cam by grade rank; tie-broken by the lower clarity %.
  const worst = perCam.reduce((a, b) => {
    if (RANK[b.water!] !== RANK[a.water!]) return RANK[b.water!] > RANK[a.water!] ? b : a;
    return (b.waterPct ?? 101) < (a.waterPct ?? 101) ? b : a;
  });

  return {
    level: worst.water,
    pct: worst.waterPct,
    note: worst.waterNote,
    capturedAtLocal,
    perCam,
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
    const data = summarizeClarity(feed, { timezone: loc.timezone });
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
