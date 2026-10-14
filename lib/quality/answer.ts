// The owner's Right / Wrong tap on an alert (docs/QUALITY_PLAN.md, "Confirm").
//
// ONE atomic D1 batch writes: the label, the alert's new status, and (for a seaweed
// claim made today) the override. Nothing is half done: if any statement fails, none
// stick. A second tap on the same alert SUPERSEDES the first: the old label and override
// keep their rows, flagged superseded, and unique indexes allow one active of each per
// alert. Two taps at once cannot leave two active verdicts.
//
// A verdict binds to the EXACT claim the alert is about (cam, frame hash or time, claim
// time; lib/quality/types.ts ClaimTarget), never to "this cam" or "this moment":
//   Right                              publish exactly that claim, at its level.
//   Wrong, correct level moderate/high publish exactly that claim, at the corrected level.
//   Wrong, correct level none/low,
//     or no value                      reject that claim: nothing is published for it,
//                                      and the cam is DISPUTED for the rest of the day.
// A live override is written only when the claim was scored on today's beach-local date (the date
// of its `claimedAt`) and the alert is not expired. An answer to an older alert stores the LABEL only.

import { getLocation } from "@/config/locations";
import type { D1Like } from "@/lib/db/d1Store";
import { frameBySha, nearestFrame, nearestFramesAllCams, type FrameRef } from "@/lib/quality/frames";
import { localHourParts } from "@/lib/history/archive";
import { endOfLocalDayMs } from "@/lib/quality/localDay";
import { OWNER_TZ } from "@/lib/quality/pushPolicy";
import { ALERT_OPEN_MS, getAlert, runAtomic } from "@/lib/quality/store";
import {
  isClarityWord,
  isSeaweedLevel,
  type HourlyAlertPayload,
  type OverrideAction,
  type QualitySignal,
  type SeaweedAlertPayload,
  type SeaweedLevel,
  type Verdict,
} from "@/lib/quality/types";

/** Plausible ranges for a typed number; anything outside is a slip of the thumb. */
const RANGES: Partial<Record<QualitySignal, [number, number]>> = {
  surf: [0, 30],
  sand: [30, 190],
  score: [0, 100],
};

export type ParsedCorrect = { ok: true; value: unknown } | { ok: false };

/** The owner's "correct value" for a signal: seaweed and clarity are words, the rest numbers. Null means "not given". Pure. */
export function parseCorrect(signal: QualitySignal, raw: unknown): ParsedCorrect {
  if (raw == null) return { ok: true, value: null };
  if (typeof raw !== "object" || Array.isArray(raw)) return { ok: false };
  const o = raw as Record<string, unknown>;
  if (signal === "seaweed") return isSeaweedLevel(o.level) ? { ok: true, value: { level: o.level } } : { ok: false };
  if (signal === "clarity") return isClarityWord(o.word) ? { ok: true, value: { word: o.word } } : { ok: false };
  const range = RANGES[signal];
  if (!range) return { ok: false };
  const v = o.value;
  if (typeof v !== "number" || !Number.isFinite(v) || v < range[0] || v > range[1]) return { ok: false };
  return { ok: true, value: { value: Math.round(v * 10) / 10 } };
}

export interface VerdictEffect {
  action: OverrideAction;
  /** The level a 'publish' puts out; null for a 'reject'. */
  level: SeaweedLevel | null;
  coveragePct: number | null;
  note: string | null;
}

/** What a seaweed verdict does to its claim. Pure. */
export function verdictEffect(
  verdict: Verdict,
  claim: SeaweedAlertPayload["claim"],
  correct: unknown,
): VerdictEffect {
  if (verdict === "right") return { action: "publish", level: claim.level, coveragePct: claim.coveragePct, note: claim.note };
  const level = (correct as { level?: unknown } | null)?.level;
  if (level === "moderate" || level === "high") return { action: "publish", level, coveragePct: null, note: null };
  return { action: "reject", level: null, coveragePct: null, note: null };
}

export interface AnswerArgs {
  alertId: number;
  verdict: Verdict;
  /** Raw correct value from the request; read only when the verdict is wrong. */
  correct?: unknown;
}

export type AnswerResult =
  | { ok: true; labelId: number; overrideAdded: boolean; why?: "not-seaweed" | "expired" | "earlier-day" | "unbound" }
  | { ok: false; error: "not-found" | "bad-correct" };

function parse<T>(json: string): T | null {
  try {
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}

async function frameForLabel(db: D1Like, slug: string, kind: string, payload: SeaweedAlertPayload | HourlyAlertPayload, createdAt: string): Promise<FrameRef | null> {
  try {
    if (kind === "seaweed-held-disagreed") {
      const p = payload as SeaweedAlertPayload;
      if (p.frame?.sha256) {
        const exact = await frameBySha(db, slug, p.camId, p.frame.sha256);
        if (exact) return exact;
      }
      const at = Date.parse(p.observedAt);
      return nearestFrame(db, slug, p.camId, Number.isFinite(at) ? at : Date.parse(createdAt));
    }
    return (await nearestFramesAllCams(db, slug, Date.parse(createdAt), 1))[0] ?? null;
  } catch (e) {
    console.error("quality answer: frame lookup failed", e);
    return null;
  }
}

export async function answerAlert(db: D1Like, args: AnswerArgs, nowMs: number): Promise<AnswerResult> {
  const alert = await getAlert(db, args.alertId);
  if (!alert) return { ok: false, error: "not-found" };
  const payload = parse<SeaweedAlertPayload | HourlyAlertPayload>(alert.payload_json);
  if (!payload) return { ok: false, error: "not-found" };

  const correct = args.verdict === "wrong" ? parseCorrect(alert.signal, args.correct) : ({ ok: true, value: null } as const);
  if (!correct.ok) return { ok: false, error: "bad-correct" };

  const isSeaweed = alert.kind === "seaweed-held-disagreed";
  const sp = payload as SeaweedAlertPayload;
  const hp = payload as HourlyAlertPayload;
  const tz = getLocation(alert.slug)?.timezone ?? OWNER_TZ;
  const frame = await frameForLabel(db, alert.slug, alert.kind, payload, alert.created_at);
  const createdAt = new Date(nowMs).toISOString();
  const claimedMs = isSeaweed && sp.claimTarget?.claimedAt ? Date.parse(sp.claimTarget.claimedAt) : NaN;

  // Live only for a seaweed claim made on today's beach-local date, on an alert still open
  // (not expired by status, and not older than the open window).
  let why: "not-seaweed" | "expired" | "earlier-day" | "unbound" | undefined;
  if (!isSeaweed) why = "not-seaweed";
  else if (alert.status === "expired" || nowMs - Date.parse(alert.created_at) > ALERT_OPEN_MS) why = "expired";
  // A claim with no frame identity or no claim time cannot be told apart from its neighbors: label only.
  else if ((!sp.claimTarget?.frameSha && !sp.claimTarget?.frameAt) || !Number.isFinite(claimedMs)) why = "unbound";
  // The beach-local day is the CLAIM's (when it was scored), the same rule as ingest and the reader.
  else if (localHourParts(tz, claimedMs).date !== localHourParts(tz, nowMs).date) why = "earlier-day";
  const live = why === undefined;

  const label = db
    .prepare(
      "INSERT INTO quality_labels (alert_id, superseded, slug, signal, observed_at_utc, source, published_value, claimed_value, " +
        "verdict, correct_value, cam_id, r2_key, created_at) VALUES (?1, 0, ?2, ?3, ?4, 'alert', ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
    )
    .bind(
      alert.id,
      alert.slug,
      alert.signal,
      payload.observedAt,
      JSON.stringify(isSeaweed ? sp.published : hp.published),
      JSON.stringify(isSeaweed ? { ...sp.claim, claimTarget: sp.claimTarget } : { from: hp.from, to: hp.to, delta: hp.delta, cause: hp.cause }),
      args.verdict,
      correct.value == null ? null : JSON.stringify(correct.value),
      isSeaweed ? sp.camId : null,
      (isSeaweed ? sp.frame?.r2Key : null) ?? frame?.r2Key ?? null,
      createdAt,
    );
  const active = "(SELECT id FROM quality_labels WHERE alert_id = ?1 AND superseded = 0)";
  const stmts = [
    // A second tap supersedes the first, cleanly.
    db.prepare("UPDATE quality_labels SET superseded = 1 WHERE alert_id = ?1 AND superseded = 0").bind(alert.id),
    db.prepare("UPDATE quality_overrides SET superseded = 1 WHERE alert_id = ?1 AND superseded = 0").bind(alert.id),
    label,
  ];
  if (live) {
    const fx = verdictEffect(args.verdict, sp.claim, correct.value);
    stmts.push(
      db
        .prepare(
          "INSERT INTO quality_overrides (alert_id, label_id, superseded, slug, signal, cam_id, frame_sha, frame_at, claimed_at, local_date, " +
            `verdict, action, level, coverage_pct, note, created_at_utc, until_utc) VALUES (?1, ${active}, 0, ?2, 'seaweed', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)`,
        )
        .bind(
          alert.id,
          alert.slug,
          sp.camId,
          sp.claimTarget?.frameSha ?? null,
          sp.claimTarget?.frameAt ?? null,
          sp.claimTarget?.claimedAt ?? null,
          localHourParts(tz, claimedMs).date,
          args.verdict,
          fx.action,
          fx.level,
          fx.coveragePct,
          fx.note,
          createdAt,
          new Date(endOfLocalDayMs(tz, claimedMs)).toISOString(),
        ),
    );
  }
  stmts.push(db.prepare(`UPDATE quality_alerts SET status = 'answered', label_id = ${active} WHERE id = ?1`).bind(alert.id));
  await runAtomic(db, stmts);

  const row = await db
    .prepare("SELECT id FROM quality_labels WHERE alert_id = ?1 AND superseded = 0")
    .bind(alert.id)
    .first<{ id: number }>();
  return { ok: true, labelId: Number(row?.id ?? 0), overrideAdded: live, ...(why ? { why } : {}) };
}
