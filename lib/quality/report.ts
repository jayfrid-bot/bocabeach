// "Report conditions": the owner, standing on the beach, says what is really
// there (docs/QUALITY_PLAN.md, "Confirm"). Each answer becomes a
// `quality_labels` row with source 'report' and no verdict: the owner's word IS
// the truth. Every row also records what the app last archived for that signal,
// and the nearest saved frame of each cam, so the label can be checked against
// the pictures later.

import { getLocation } from "@/config/locations";
import type { D1Like } from "@/lib/db/d1Store";
import { nearestFramesAllCams } from "@/lib/quality/frames";
import { insertLabel, latestHourlyRow } from "@/lib/quality/store";
import {
  isClarityWord,
  isSeaweedLevel,
  type ClarityWord,
  type QualitySignal,
  type SeaweedLevel,
} from "@/lib/quality/types";

export const NOTE_MAX = 500;

export interface ReportInput {
  slug: string;
  seaweed?: SeaweedLevel;
  clarity?: ClarityWord;
  surfFt?: number;
  sandF?: number;
  note?: string;
}

export type ParsedReport = { ok: true; value: ReportInput } | { ok: false; error: "bad-request" | "unknown-beach" | "empty" };

function optNumber(v: unknown, min: number, max: number): number | undefined | null {
  if (v == null || v === "") return undefined;
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) return null;
  return Math.round(v * 10) / 10;
}

/** Check a report body. A field left out is fine; a field that is present and wrong is refused. Pure. */
export function parseReport(body: Record<string, unknown>): ParsedReport {
  const slug = body.slug;
  if (typeof slug !== "string") return { ok: false, error: "bad-request" };
  if (!getLocation(slug)) return { ok: false, error: "unknown-beach" };
  const out: ReportInput = { slug };
  if (body.seaweed != null) {
    if (!isSeaweedLevel(body.seaweed)) return { ok: false, error: "bad-request" };
    out.seaweed = body.seaweed;
  }
  if (body.clarity != null) {
    if (!isClarityWord(body.clarity)) return { ok: false, error: "bad-request" };
    out.clarity = body.clarity;
  }
  const surf = optNumber(body.surfFt, 0, 30);
  const sand = optNumber(body.sandF, 30, 190);
  if (surf === null || sand === null) return { ok: false, error: "bad-request" };
  if (surf !== undefined) out.surfFt = surf;
  if (sand !== undefined) out.sandF = sand;
  if (body.note != null) {
    if (typeof body.note !== "string") return { ok: false, error: "bad-request" };
    const note = body.note.trim().slice(0, NOTE_MAX);
    if (note) out.note = note;
  }
  if (!out.seaweed && !out.clarity && out.surfFt === undefined && out.sandF === undefined && !out.note) {
    return { ok: false, error: "empty" };
  }
  return { ok: true, value: out };
}

interface LatestRow {
  hour_utc: string;
  seaweed_level: string | null;
  clarity_pct: number | null;
  surf_ft: number | null;
  sand_temp_f: number | null;
}

const LATEST_COLS = "hour_utc, seaweed_level, clarity_pct, surf_ft, sand_temp_f";

export interface ReportResult {
  labelIds: number[];
  /** How many saved frames were attached. */
  frames: number;
}

/** Save one report as one label per signal reported (a note alone is one 'other' label). */
export async function saveReport(db: D1Like, input: ReportInput, nowMs: number): Promise<ReportResult> {
  const at = new Date(nowMs).toISOString();
  const refs = await nearestFramesAllCams(db, input.slug, nowMs, 6);
  const frames = refs.map((r) => ({ camId: r.camId, r2Key: r.r2Key, displayAtUtc: r.displayAtUtc }));
  const latest = await latestHourlyRow<LatestRow>(db, LATEST_COLS, input.slug);

  const rows: Array<{ signal: QualitySignal; published: unknown; correct: unknown }> = [];
  const seen = (value: unknown) => ({ value: value ?? null, hourUtc: latest?.hour_utc ?? null });
  if (input.seaweed) rows.push({ signal: "seaweed", published: seen(latest?.seaweed_level), correct: { level: input.seaweed } });
  if (input.clarity) rows.push({ signal: "clarity", published: seen(latest?.clarity_pct), correct: { word: input.clarity } });
  if (input.surfFt !== undefined) rows.push({ signal: "surf", published: seen(latest?.surf_ft), correct: { value: input.surfFt } });
  if (input.sandF !== undefined) rows.push({ signal: "sand", published: seen(latest?.sand_temp_f), correct: { value: input.sandF } });
  if (!rows.length) rows.push({ signal: "other", published: null, correct: null });

  const labelIds: number[] = [];
  for (const r of rows) {
    labelIds.push(
      await insertLabel(db, {
        slug: input.slug,
        signal: r.signal,
        observedAt: at,
        source: "report",
        published: r.published,
        verdict: null,
        correct: r.correct,
        r2Key: frames[0]?.r2Key ?? null,
        frames: frames.length ? frames : null,
        note: input.note ?? null,
        createdAt: at,
      }),
    );
  }
  return { labelIds, frames: frames.length };
}
