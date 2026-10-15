// Plain words for the owner's alerts (docs/QUALITY_PLAN.md). Pure: one place
// for the push text and for the sentence the review card asks about. The word
// "AI" never appears; the owner reads these on a phone, at the beach.

import { getLocation } from "@/config/locations";
import type {
  AlertKind,
  HourlyAlertPayload,
  OtherCamReading,
  QualitySignal,
  SeaweedAlertPayload,
} from "@/lib/quality/types";

export function beachName(slug: string): string {
  return getLocation(slug)?.name ?? slug;
}

/** "Boca Inlet Surf Cam" -> "Boca Inlet Surf", so "<name> cam says" reads once. */
export function camLabel(camName: string): string {
  const trimmed = camName.replace(/\s+cam$/i, "").trim();
  return trimmed || camName;
}

/** The other cams' readings in a few words: "none", "low", or "A: none, B: low". */
export function othersText(others: OtherCamReading[]): string {
  if (!others.length) return "no other readings";
  const levels = new Set(others.map((o) => o.level));
  if (levels.size === 1) return others[0].level;
  return others.map((o) => `${camLabel(o.name)}: ${o.level}`).join(", ");
}

function pct(p: number | null | undefined): string {
  return typeof p === "number" && Number.isFinite(p) ? ` (${Math.round(p)}%)` : "";
}

export function seaweedStatement(p: SeaweedAlertPayload): string {
  return `${camLabel(p.camName)} cam says ${p.claim.level} seaweed${pct(p.claim.coveragePct)}`;
}

const SIGNAL_WORDS: Record<QualitySignal, string> = {
  seaweed: "Seaweed",
  clarity: "Water clarity",
  surf: "Surf",
  sand: "Sand temperature",
  score: "Beach Day score",
  crowd: "Crowd",
  other: "Reading",
};
export function signalWord(signal: QualitySignal): string {
  return SIGNAL_WORDS[signal];
}

function fmt(signal: QualitySignal, n: number): string {
  switch (signal) {
    case "surf":
      return `${Math.round(n * 10) / 10} ft`;
    case "sand":
      return `${Math.round(n)} F`;
    case "clarity":
      return `${Math.round(n)}% clear`;
    default:
      return `${Math.round(n)}`;
  }
}

/** The sentence the review card asks "Is this right?" about. */
export function hourlyStatement(signal: QualitySignal, p: HourlyAlertPayload): string {
  return `${signalWord(signal)} went from ${fmt(signal, p.from)} to ${fmt(signal, p.to)} in an hour`;
}

export function statementFor(kind: AlertKind, signal: QualitySignal, payload: unknown): string {
  if (kind === "seaweed-held-disagreed") return seaweedStatement(payload as SeaweedAlertPayload);
  return hourlyStatement(signal, payload as HourlyAlertPayload);
}

/** The push: the beach as the title, one short plain line as the body. */
export function pushCopy(slug: string, kind: AlertKind, signal: QualitySignal, payload: unknown): { title: string; body: string } {
  const title = beachName(slug);
  if (kind === "seaweed-held-disagreed") {
    const p = payload as SeaweedAlertPayload;
    return { title, body: `Check: ${seaweedStatement(p)}. Other cams: ${othersText(p.others)}.` };
  }
  const p = payload as HourlyAlertPayload;
  return { title, body: `Check: ${hourlyStatement(signal, p)}, and nothing obvious explains it.` };
}
