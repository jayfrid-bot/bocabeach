import type { BusynessData } from "@/lib/types";
import { BUSYNESS_SLOTS, busynessFilledSlots } from "@/lib/busynessFill";
import { fmtTime } from "@/lib/format";
import { busynessVsAvgPhrase, type VsAvgTone } from "@/lib/vsAveragePhrase";

const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

/** A local hour (0-23) as a plain clock word: 14 → "2 PM". */
function hourLabel(hour: number): string {
  const h = ((Math.round(hour) % 24) + 24) % 24;
  return `${h % 12 === 0 ? 12 : h % 12} ${h < 12 ? "AM" : "PM"}`;
}

/** Tone → colour: busier = amber, quieter = emerald, typical = slate. */
const TONE_CLASS: Record<VsAvgTone, string> = {
  busier: "text-amber-700 dark:text-amber-400",
  quieter: "text-emerald-700 dark:text-emerald-400",
  typical: "text-slate-500 dark:text-slate-400",
};

/**
 * Quiet one-liner comparing today's crowd to a typical same-weekday beach.
 * Renders nothing until there's enough history (deltaPct null with no points
 * fallback). The rounding/band/wording live in lib/vsAveragePhrase.ts; here we
 * only map the tone to a colour. The sample detail lives in the title, not the text.
 */
function BusynessVsAvgLine({ vsAvg }: { vsAvg: NonNullable<BusynessData["vsAvg"]> }) {
  const phrase = busynessVsAvgPhrase(vsAvg);
  if (!phrase) return null;
  const title = `${vsAvg.baselineDays}-day hour-matched, same-weekday baseline`;
  return (
    <div className={`mt-1 text-xs ${TONE_CLASS[phrase.tone]}`} title={title}>
      {phrase.text}
    </div>
  );
}

/** One umbrella-and-pole silhouette, filled/ghosted/dimmed per its slot state.
 *  "muted" is a filled umbrella at half strength — a remembered crowd from the
 *  last readable day, drawn so it can never be mistaken for a live one. */
type UmbrellaState = "filled" | "ghost" | "dimmed" | "muted";
function Umbrella({ state }: { state: UmbrellaState }) {
  const opacity =
    state === "filled" ? 1 : state === "muted" ? 0.45 : state === "ghost" ? 0.28 : 0.16;
  const fill = state === "filled" || state === "muted" ? "#146de1" : "currentColor"; // ocean-700
  return (
    <svg viewBox="0 0 24 30" className="h-5 w-5 sm:h-6 sm:w-6" aria-hidden>
      <path
        d="M12 2C6.5 2 2 6.6 2 11.8h20C22 6.6 17.5 2 12 2Z"
        fill={fill}
        opacity={opacity}
      />
      <rect x="11" y="11.5" width="2" height="16.5" rx="1" fill={fill} opacity={opacity} />
    </svg>
  );
}

/**
 * Beach busyness card: a sand-colored strip of ~10 umbrella silhouettes, N of
 * them filled in for the current crowd %. Honors the honest gating from
 * lib/sources/busyness.ts — when the cams can't read the beach right now
 * (night, or a stale capture), the card stops claiming a live reading. Instead
 * of the bare "we can't see the beach", it says what the beach DID on the last
 * day the cams could read it — dimmed, captioned with the day, and followed by
 * when the next read lands. Only a beach with no readable day behind it falls
 * back to the plain "cams can't see in the dark" note. Renders nothing when
 * this beach has no busyness source at all (no cams).
 */
export function BusynessCard({ busy, tz }: { busy?: BusynessData | null; tz?: string }) {
  if (!busy) return null;
  const isUnknown = busy.level === "unknown";
  // Matches the old MetricCard's gate: an unknown level with no note at all
  // means there's nothing worth showing (not even a "why"), so hide the card.
  if (isUnknown && !busy.note) return null;

  if (isUnknown) {
    const y = busy.yesterday;
    // "Next cam read ~6:40 AM" needs the beach's clock; without a tz we simply
    // leave the line off rather than quote a server-local time.
    const nextRead =
      busy.nextReadIso && tz ? `Next cam read ~${fmtTime(busy.nextReadIso, tz)}` : null;
    const filled = y ? busynessFilledSlots(y.avgCrowdPct, y.level) : 0;
    // One quiet closing line: when the cams come back — or, for a daytime
    // outage (no knowable end, so no nextRead), why they're out at all. Without
    // a day summary the note is already the main line, so it isn't repeated.
    const tail = y ? nextRead ?? busy.note : nextRead;

    return (
      <div className="flex h-full flex-col rounded-2xl bg-white/80 p-4 ring-1 ring-slate-900/10 dark:bg-slate-900/70 dark:ring-white/10">
        <div className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400">
          <span aria-hidden>👥</span>
          <span>Beach busyness</span>
        </div>
        <div className="mt-1 text-xl font-semibold text-slate-500 dark:text-slate-400 sm:text-2xl">
          {y ? `${cap(y.dayLabel)}: ${cap(y.level)}` : "Unknown right now"}
        </div>
        <div className="mt-2 flex flex-wrap gap-1 rounded-xl bg-slate-100/80 p-2 text-slate-400 dark:bg-slate-950/40 dark:text-slate-600">
          {Array.from({ length: BUSYNESS_SLOTS }, (_, i) => (
            <Umbrella key={i} state={y && i < filled ? "muted" : "dimmed"} />
          ))}
        </div>
        <div className="mt-2 flex items-start gap-1.5 text-xs text-slate-600 dark:text-slate-400">
          <span aria-hidden>🌙</span>
          <span>
            {y
              ? `${y.dayLabel}'s average · peaked ${cap(y.peakLevel)} ~${hourLabel(y.peakHourLocal)}`
              : busy.note}
          </span>
        </div>
        {tail ? (
          <div className="mt-1 text-xs text-slate-500 dark:text-slate-500">{tail}</div>
        ) : null}
        {busy.vsAvg ? <BusynessVsAvgLine vsAvg={busy.vsAvg} /> : null}
      </div>
    );
  }

  const filled = busynessFilledSlots(busy.crowdPct, busy.level);
  // One reading, said once: "N of SLOTS umbrellas" already carries the % full
  // (it's the same ratio) — appending a separately-computed "X% full" repeated
  // the same fact twice. The people estimate is the only additional number.
  const sub = busy.peopleEstimate != null ? `~${busy.peopleEstimate} people` : undefined;

  return (
    <div className="flex h-full flex-col rounded-2xl bg-white/80 p-4 ring-1 ring-slate-900/10 dark:bg-slate-900/70 dark:ring-white/10">
      <div className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400">
        <span aria-hidden>👥</span>
        <span>Beach busyness</span>
      </div>
      <div className="mt-1 text-xl font-semibold text-slate-900 dark:text-white sm:text-2xl">
        {cap(busy.level)}
      </div>
      <div className="mt-2 flex flex-wrap gap-1 rounded-xl bg-amber-100/70 p-2 dark:bg-slate-950/30">
        {Array.from({ length: BUSYNESS_SLOTS }, (_, i) => (
          <Umbrella key={i} state={i < filled ? "filled" : "ghost"} />
        ))}
      </div>
      <div className="mt-2 text-xs text-slate-600 dark:text-slate-400">
        {filled} of {BUSYNESS_SLOTS} umbrellas
        {sub ? ` · ${sub}` : ""}
      </div>
      {busy.vsAvg ? <BusynessVsAvgLine vsAvg={busy.vsAvg} /> : null}
    </div>
  );
}
