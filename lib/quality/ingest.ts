// Validation for the seaweed alert the cam reader POSTs to /api/quality/alerts
// (scripts/cam_seaweed.py -> scripts/quality_watch.py builds the body). The
// reader is our own code, but the route is reachable with a bearer token, so
// every field is checked and every string is cut to a sane length. Pure.

import { getLocation } from "@/config/locations";
import { isValidId } from "@/lib/camFrames/keys";
import { decodeAlertFrame } from "@/lib/quality/frameUpload";
import { localHourParts } from "@/lib/history/archive";
import { isSeaweedLevel, type ClaimTarget, type OtherCamReading, type SeaweedAlertPayload, type SeaweedLevel } from "@/lib/quality/types";

/** A frame time may be this far ahead of the server clock, or this far behind it. */
const MAX_FUTURE_MS = 10 * 60_000;
const MAX_AGE_MS = 12 * 3_600_000;
const MAX_OTHERS = 8;

export interface ParsedSeaweedAlert {
  slug: string;
  payload: SeaweedAlertPayload;
  dedupeKey: string;
  /** The shrunk JPEG sent with the alert, checked; null when none came or it failed the checks (the alert still stands). */
  frameJpeg: Uint8Array | null;
}

export type IngestResult = { ok: true; value: ParsedSeaweedAlert } | { ok: false; error: string };

function str(v: unknown, max: number): string | null {
  return typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;
}
function pct(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100 ? Math.round(v) : null;
}
/** An ISO time kept EXACTLY as the reader wrote it (identity is compared as text), or null. */
function stamp(v: unknown): string | null {
  return typeof v === "string" && v.length <= 40 && Number.isFinite(Date.parse(v)) ? v : null;
}
function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

export function parseSeaweedAlert(body: Record<string, unknown>, nowMs: number): IngestResult {
  const slug = str(body.slug, 64);
  if (!slug || !getLocation(slug)) return { ok: false, error: "unknown-beach" };
  const camId = str(body.camId, 64);
  if (!camId || !isValidId(camId)) return { ok: false, error: "bad-cam" };
  const camName = str(body.camName, 80) ?? camId;

  const observedRaw = str(body.observedAt, 40);
  const observedMs = observedRaw ? Date.parse(observedRaw) : NaN;
  if (!Number.isFinite(observedMs) || observedMs - nowMs > MAX_FUTURE_MS || nowMs - observedMs > MAX_AGE_MS) {
    return { ok: false, error: "bad-time" };
  }
  const observedAt = new Date(observedMs).toISOString();

  const claim = obj(body.claim);
  const second = obj(body.secondOpinion);
  if (!claim || !isSeaweedLevel(claim.level) || (claim.level !== "moderate" && claim.level !== "high")) {
    return { ok: false, error: "bad-claim" };
  }
  const secondProvider = second ? str(second.provider, 24) : null;
  if (!second || !secondProvider) return { ok: false, error: "bad-second-opinion" };
  const secondLevel: SeaweedLevel | null = isSeaweedLevel(second.level) ? second.level : null;
  // The route only records a DISAGREEMENT. If the second reader also said moderate+, the reader confirmed it itself.
  if (secondLevel === "moderate" || secondLevel === "high") return { ok: false, error: "not-a-disagreement" };

  const others: OtherCamReading[] = [];
  if (Array.isArray(body.others)) {
    for (const o of body.others.slice(0, MAX_OTHERS * 4)) {
      if (others.length >= MAX_OTHERS) break;
      const r = obj(o);
      const id = r ? str(r.id, 64) : null;
      if (!r || !id || !isSeaweedLevel(r.level)) continue;
      others.push({ id, name: str(r.name, 80) ?? id, level: r.level, coveragePct: pct(r.coveragePct), carried: r.carried === true });
    }
  }

  let published: SeaweedAlertPayload["published"] = null;
  const pub = obj(body.published);
  if (pub) published = { level: isSeaweedLevel(pub.level) ? pub.level : null, pct: pct(pub.pct) };

  const frame = obj(body.frame);
  const sha = frame && typeof frame.sha256 === "string" && /^[0-9a-f]{64}$/.test(frame.sha256) ? frame.sha256 : null;

  // The exact claim: the frame (hash for feed cams, else the frame's time) and when it was scored.
  const ct = obj(body.claimTarget);
  const claimTarget: ClaimTarget = {
    frameSha: ct && typeof ct.frameSha === "string" && /^[0-9a-f]{8,64}$/.test(ct.frameSha) ? ct.frameSha.slice(0, 20) : null,
    frameAt: ct ? stamp(ct.frameAt) : null,
    claimedAt: ct ? stamp(ct.claimedAt) : null,
  };
  const tz = getLocation(slug)?.timezone ?? "America/New_York";

  const payload: SeaweedAlertPayload = {
    camId,
    camName,
    observedAt,
    published,
    claim: {
      level: claim.level,
      coveragePct: pct(claim.coveragePct),
      note: str(claim.note, 200),
      provider: str(claim.provider, 24),
      model: str(claim.model, 80),
    },
    secondOpinion: {
      provider: secondProvider,
      model: str(second.model, 80),
      level: secondLevel,
      coveragePct: pct(second.coveragePct),
      note: str(second.note, 200),
    },
    others,
    claimTarget,
    localDate: localHourParts(tz, observedMs).date,
    frame: { sha256: sha, archivedThisTick: frame?.archivedThisTick === true, r2Key: null },
  };
  // One alert per exact image; with no hash, one per cam and frame time.
  const dedupeKey = `seaweed:${slug}:${camId}:${sha ? sha.slice(0, 16) : observedAt}`;
  return { ok: true, value: { slug, payload, dedupeKey, frameJpeg: decodeAlertFrame(frame?.jpegB64) } };
}
