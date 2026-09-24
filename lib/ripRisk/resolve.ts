// Pure temporal resolution: given the raw NWS alert(s), SRF periods, and an
// optional NOAA model reading, decide what rip risk applies AT `now`. Never reads the
// clock itself — every timestamp comparison takes `now` as a parameter, so
// server render and client refresh can pin to different clocks deliberately
// (see lib/conditions.ts's snapshot.generatedAt pinning convention) without
// this module ever disagreeing with itself.

import type {
  AlertStatus,
  OfficialAlertNow,
  OfficialForecastNow,
  OfficialModelNow,
  RipHour,
  RipNow,
} from "@/lib/ripRisk/types";
import { isRipAlertEvent } from "@/lib/ripRisk/types";
import type { NwsAlert, RipRisk, SrfPeriod } from "@/lib/types";

/**
 * Probability -> Low/Moderate/High banding for NOAA's rip current model.
 *
 * NWS/NOAA (the NWPS rip current model's operator, Dusek & Seim 2013,
 * operational 2021) publish the model's 0-100% probability itself but do
 * NOT publish a single documented probability-to-Low/Moderate/High mapping
 * table (checked: the model's Virtual Lab page, NWS Melbourne's Rip Current
 * Threat Index page, and the surf-zone-forecast product guides — none give
 * numeric cutoffs, only qualitative wording). Absent an official table, this
 * is THE APP'S OWN mapping, labeled as such everywhere it's shown:
 *   Low      < 20%
 *   Moderate 20% – < 50%
 *   High     >= 50%
 */
export function levelForModelProb(prob: number): Exclude<RipRisk, "unknown"> {
  if (prob >= 50) return "high";
  if (prob >= 20) return "moderate";
  return "low";
}

/** A model run older than this is treated as unavailable (lib/sources/ripNwps.ts
 *  applies the same gate before ever handing a series to a caller). */
export const MODEL_STALE_MS = 36 * 3_600_000;

export function isModelFresh(run: string, nowMs: number): boolean {
  const runMs = Date.parse(run);
  return Number.isFinite(runMs) && nowMs - runMs <= MODEL_STALE_MS && nowMs - runMs >= -3_600_000;
}

/** The model hour covering `nowMs` (top-of-hour <= nowMs < top-of-hour + 1h),
 *  or null when there's no fresh coverage for that instant. */
export function modelNowFrom(hours: RipHour[] | undefined, nowMs: number): OfficialModelNow | null {
  if (!hours?.length) return null;
  for (const h of hours) {
    const t = Date.parse(h.t);
    if (!Number.isFinite(t)) continue;
    if (nowMs >= t && nowMs < t + 3_600_000 && h.officialModel && isModelFresh(h.officialModel.run, nowMs)) {
      return h.officialModel;
    }
  }
  return null;
}

/** Active interval = [onset ?? effective, ends ?? expires). Resolved fresh
 *  against `nowMs` every call — never cached as a boolean. */
export function alertStatus(onsetMs: number, endMs: number, nowMs: number): AlertStatus {
  if (Number.isFinite(endMs) && nowMs >= endMs) return "ended";
  if (Number.isFinite(onsetMs) && nowMs < onsetMs) return "scheduled";
  return "inEffect";
}

/**
 * THE shared "is this alert actually in effect right now" check — every
 * generic (non-rip) alert path in the app must use this, not a bare event-
 * name match, so a scheduled-but-not-yet-started or already-ended product
 * never reads as active. Used by score.ts's severeAlert/surfAdvisory caps,
 * SafetyBanner's beach-hazard/other-alert partitions, safetyTone's alert
 * severity input, and evaluate.ts's generic beach-hazard push path — one
 * function, so they can never disagree about "in effect" the way the rip
 * alert / SRF word / model can never disagree (resolveRipNow above).
 * An alert with no parseable onset/end interval is treated as NOT in effect
 * (never as "always active" — an honest unknown, not an assumed yes).
 */
export function isAlertInEffectAt(a: NwsAlert, nowMs: number): boolean {
  const onsetIso = a.onset ?? a.effective;
  const endIso = a.ends ?? a.expires;
  if (!onsetIso || !endIso) return false;
  const onsetMs = Date.parse(onsetIso);
  const endMs = Date.parse(endIso);
  if (!Number.isFinite(onsetMs) || !Number.isFinite(endMs)) return false;
  return alertStatus(onsetMs, endMs, nowMs) === "inEffect";
}

/** True when `a`'s onset hasn't started yet (a real future product, not one
 *  already in effect or ended) — powers the "upcoming" blocks (item 1: a
 *  scheduled product is shown ONLY there, never folded into a generic
 *  in-effect list). */
export function isAlertUpcomingAt(a: NwsAlert, nowMs: number): boolean {
  const onsetIso = a.onset ?? a.effective;
  const endIso = a.ends ?? a.expires;
  if (!onsetIso || !endIso) return false;
  const onsetMs = Date.parse(onsetIso);
  const endMs = Date.parse(endIso);
  if (!Number.isFinite(onsetMs) || !Number.isFinite(endMs)) return false;
  return alertStatus(onsetMs, endMs, nowMs) === "scheduled";
}

/**
 * The STABLE id for this alert's real-world incident, across CAP updates.
 * NWS commonly issues a NEW `id` on each "Update" messageType, but chains
 * them via CAP `references` (a list of every prior alert this one
 * supersedes) — so the FIRST identifier in that chain is the original
 * incident's id, and stays constant across every later revision. Falls back
 * to `a.id` when there's no references chain (a fresh, non-updated alert).
 * This is what makes catalog.ts's `rip:<id>` dedup key stay the SAME across
 * an update of the same incident, so it doesn't re-push.
 */
export function canonicalAlertId(a: NwsAlert): string | undefined {
  if (!a.references) return a.id;
  const first = a.references.trim().split(/\s+/)[0];
  if (!first) return a.id;
  // api.weather.gov references are either raw CAP "sender,identifier,sent"
  // triples or full alert URLs (…/alerts/urn:oid:...) — the identifier is
  // the 2nd comma field in the former, the last path segment in the latter.
  if (first.includes(",")) {
    const parts = first.split(",");
    return parts[1] || a.id;
  }
  const lastSlash = first.lastIndexOf("/");
  return lastSlash >= 0 ? first.slice(lastSlash + 1) : first;
}

function toOfficialAlertNow(a: NwsAlert, nowMs: number): OfficialAlertNow | null {
  const onsetIso = a.onset ?? a.effective;
  const endIso = a.ends ?? a.expires;
  const id = canonicalAlertId(a);
  if (!onsetIso || !endIso || !id) return null;
  const onsetMs = Date.parse(onsetIso);
  const endMs = Date.parse(endIso);
  if (!Number.isFinite(onsetMs) || !Number.isFinite(endMs)) return null;
  return {
    id,
    event: a.event,
    status: alertStatus(onsetMs, endMs, nowMs),
    onset: onsetIso,
    end: endIso,
  };
}

/** Every rip-relevant alert (Rip Current Statement, or a Beach Hazards
 *  Statement whose text mentions rip currents), resolved against `nowMs`. */
export function ripAlertsNow(alerts: NwsAlert[], nowMs: number): OfficialAlertNow[] {
  return alerts
    .filter(isRipAlertEvent)
    .map((a) => toOfficialAlertNow(a, nowMs))
    .filter((a): a is OfficialAlertNow => a != null);
}

/** The SRF period whose window contains `nowMs`, or (when no period carries a
 *  window — see nws.ts's parseSrfPeriods) the first period in the list, since
 *  a windowless SRF is still "today's word" by convention. */
export function currentSrfPeriod(periods: SrfPeriod[] | undefined, nowMs: number): OfficialForecastNow | null {
  if (!periods || !periods.length) return null;
  for (const p of periods) {
    if (p.start && p.end) {
      const s = Date.parse(p.start);
      const e = Date.parse(p.end);
      if (Number.isFinite(s) && Number.isFinite(e) && nowMs >= s && nowMs < e) {
        return { level: p.level, periodLabel: p.label, start: p.start, end: p.end };
      }
    }
  }
  const hasAnyWindow = periods.some((p) => p.start && p.end);
  if (hasAnyWindow) return null; // now falls outside every windowed period
  const first = periods[0];
  return { level: first.level, periodLabel: first.label };
}

const LEVEL_RANK: Record<RipRisk, number> = { unknown: -1, low: 0, moderate: 1, high: 2 };
const RANK_LEVEL: Exclude<RipRisk, "unknown">[] = ["low", "moderate", "high"];

/** One band below `level` (high->moderate->low), floored at low. Used by the
 *  fresh-model-vs-SRF disagreement rule below — a fresh model is trusted to
 *  pull the resolved level down, but only ONE step, never straight to Low
 *  under a High SRF word. */
function stepDown(level: Exclude<RipRisk, "unknown">): Exclude<RipRisk, "unknown"> {
  return RANK_LEVEL[Math.max(0, LEVEL_RANK[level] - 1)];
}

function higherLevel(
  a: Exclude<RipRisk, "unknown">,
  b: Exclude<RipRisk, "unknown">,
): Exclude<RipRisk, "unknown"> {
  return LEVEL_RANK[a] >= LEVEL_RANK[b] ? a : b;
}

/** Model freshness tiers (lib/sources/ripNwps.ts's staleness gate applies the
 *  outer 36h cutoff before a model value ever reaches here — MODEL_STALE_MS). */
const MODEL_TRUSTED_MS = 18 * 3_600_000;

/**
 * Resolve "what applies right now":
 *   1. An alert ACTUALLY IN EFFECT right now -> always HIGH, regardless of
 *      what the SRF word or model says (a Rip Current Statement in effect is
 *      never downgraded by a disagreeing model/forecast).
 *   2. A fresh model (run age <= 18h) together with an SRF word -> the higher
 *      of {model band, one band below the SRF word} — the model can pull the
 *      result down, but only one step, never straight past the SRF word.
 *   3. A fresh model (run age <= 18h) with no SRF word -> the model band, as-is.
 *   4. An aging model (18h < run age <= 36h) together with an SRF word -> the
 *      model may UPGRADE the SRF word (model higher than SRF wins) but never
 *      downgrade it (an aging model is trusted less for pulling risk down).
 *   5. An aging model with no SRF word -> the model band, as-is.
 *   6. No usable model (stale/absent) -> the current SRF word.
 *   7. Neither -> unknown.
 *
 * A SCHEDULED (not-yet-started) alert never wins the resolved source/level —
 * it's surfaced separately as `upcomingAlert`. An ENDED alert is likewise
 * never active. `watch` is set whenever the resolved level reads LOWER than
 * the current SRF word (a real disagreement worth flagging in the UI),
 * regardless of source — callers search the model's own future hours (see
 * lib/sources/ripNwps.ts's `firstFutureHighHour`) for a "rising to High by…"
 * time, or fall back to naming the disagreement plainly.
 */
export function resolveRipNow(input: {
  alerts: NwsAlert[];
  srfPeriods?: SrfPeriod[];
  model?: OfficialModelNow | null;
  now: number;
  /** When resolving for an HOUR BUCKET (e.g. score.ts's hourly forecast, or
   *  RipRiskCard's model strip) rather than a single instant, pass the
   *  bucket's end (now + 1h) so an alert that starts or ends MID-BUCKET
   *  still marks the whole hour — overlap test `hourStart < alertEnd &&
   *  hourEnd > alertStart`, not just whether the bucket's start instant
   *  happens to fall inside the alert. Omit for a true "right now" read
   *  (the live NOW badge), which correctly wants the point-in-time check. */
  hourEndMs?: number;
}): RipNow {
  const { alerts, srfPeriods, model, now, hourEndMs } = input;
  const ripAlerts = ripAlertsNow(alerts, now);
  const inEffect =
    hourEndMs != null
      ? ripAlerts.find((a) => now < Date.parse(a.end) && hourEndMs > Date.parse(a.onset)) ?? null
      : ripAlerts.find((a) => a.status === "inEffect") ?? null;
  const upcoming =
    ripAlerts
      .filter((a) => a.status === "scheduled")
      .sort((a, b) => Date.parse(a.onset) - Date.parse(b.onset))[0] ?? null;

  const period = currentSrfPeriod(srfPeriods, now);
  const freshModel = model && isModelFresh(model.run, now) ? model : null;
  const modelAgeMs = freshModel ? now - Date.parse(freshModel.run) : null;
  const modelTrusted = modelAgeMs != null && modelAgeMs <= MODEL_TRUSTED_MS;

  // Item 2: an alert IN EFFECT is always HIGH — never downgraded by a
  // disagreeing SRF word or model reading.
  if (inEffect) {
    return {
      source: "alert",
      level: "high",
      alert: inEffect,
      upcomingAlert: null,
      period,
      model: freshModel,
      watch: false,
    };
  }

  let level: RipRisk = "unknown";
  let source: RipNow["source"] = "unknown";

  if (freshModel && period && period.level !== "unknown") {
    level = modelTrusted
      ? higherLevel(freshModel.level, stepDown(period.level))
      : higherLevel(freshModel.level, period.level); // aging model: upgrade-only
    source = "model";
  } else if (freshModel) {
    level = freshModel.level;
    source = "model";
  } else if (period && period.level !== "unknown") {
    level = period.level;
    source = "forecast";
  }

  const watch = !!(period && period.level !== "unknown" && level !== "unknown" && LEVEL_RANK[level] < LEVEL_RANK[period.level]);

  return {
    source,
    level,
    alert: null,
    upcomingAlert: upcoming,
    period,
    model: freshModel,
    watch,
  };
}

/** The score cap this resolved status implies, per spec:
 *   - alert in effect (always High) OR resolved level High -> 85
 *   - resolved level Moderate -> 92
 *   - a scheduled (future) alert alone -> no cap at all
 */
export function ripCapFor(now: RipNow | undefined): number | null {
  if (!now) return null;
  if (now.level === "high") return 85;
  if (now.level === "moderate") return 92;
  return null;
}

export { LEVEL_RANK, stepDown, higherLevel };
