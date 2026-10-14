// The owner's Right / Wrong tap on an alert (docs/QUALITY_PLAN.md, "Confirm").
// It writes a `quality_labels` row, closes the alert, and, for a seaweed
// alert, adds a `quality_overrides` row, so the live summary and the cam reader
// drop that cam's claim (Wrong) or publish it (Right) (lib/quality/seaweedOverrides.ts).

import { getLocation } from "@/config/locations";
import type { D1Like } from "@/lib/db/d1Store";
import { frameBySha, nearestFrame, nearestFramesAllCams, type FrameRef } from "@/lib/quality/frames";
import { endOfLocalDayMs } from "@/lib/quality/localDay";
import { OWNER_TZ } from "@/lib/quality/pushPolicy";
import { getAlert, insertLabel, insertOverride, markAnswered } from "@/lib/quality/store";
import {
  isClarityWord,
  isSeaweedLevel,
  type HourlyAlertPayload,
  type QualitySignal,
  type SeaweedAlertPayload,
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

export interface AnswerArgs {
  alertId: number;
  verdict: Verdict;
  /** Raw correct value from the request; read only when the verdict is wrong. */
  correct?: unknown;
}

export type AnswerResult =
  | { ok: true; labelId: number; overrideAdded: boolean }
  | { ok: false; error: "not-found" | "already-answered" | "bad-correct" };

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
  if (alert.status === "answered") return { ok: false, error: "already-answered" };
  const payload = parse<SeaweedAlertPayload | HourlyAlertPayload>(alert.payload_json);
  if (!payload) return { ok: false, error: "not-found" };

  const correct = args.verdict === "wrong" ? parseCorrect(alert.signal, args.correct) : ({ ok: true, value: null } as const);
  if (!correct.ok) return { ok: false, error: "bad-correct" };

  const isSeaweed = alert.kind === "seaweed-held-disagreed";
  const sp = payload as SeaweedAlertPayload;
  const hp = payload as HourlyAlertPayload;
  const frame = await frameForLabel(db, alert.slug, alert.kind, payload, alert.created_at);
  const createdAt = new Date(nowMs).toISOString();

  const labelId = await insertLabel(db, {
    slug: alert.slug,
    signal: alert.signal,
    observedAt: payload.observedAt,
    source: "alert",
    published: isSeaweed ? sp.published : hp.published,
    claimed: isSeaweed ? sp.claim : { from: hp.from, to: hp.to, delta: hp.delta, cause: hp.cause },
    verdict: args.verdict,
    correct: correct.value,
    camId: isSeaweed ? sp.camId : null,
    r2Key: (isSeaweed ? sp.frame?.r2Key : null) ?? frame?.r2Key ?? null,
    createdAt,
  });
  if (!(await markAnswered(db, alert.id, labelId))) return { ok: false, error: "already-answered" };

  // A seaweed verdict is honored live: Wrong drops the cam's claim, Right publishes it.
  // Both last until the end of the beach-local day, or the cam's next fresh reading.
  let overrideAdded = false;
  if (isSeaweed) {
    const tz = getLocation(alert.slug)?.timezone ?? OWNER_TZ;
    await insertOverride(db, {
      slug: alert.slug,
      signal: "seaweed",
      camId: sp.camId,
      createdAtUtc: createdAt,
      untilUtc: new Date(endOfLocalDayMs(tz, nowMs)).toISOString(),
      labelId,
      verdict: args.verdict,
      claim: args.verdict === "right" ? { level: sp.claim.level, coveragePct: sp.claim.coveragePct, note: sp.claim.note } : null,
    });
    overrideAdded = true;
  }
  return { ok: true, labelId, overrideAdded };
}
