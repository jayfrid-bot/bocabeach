// What the owner's review screen shows (docs/QUALITY_PLAN.md, "Confirm"): the
// open alerts first, then the recent ones, each with its archived frame, what was
// published against what was claimed, and the other cams. `shapeAlert` is pure;
// `loadReview` adds the D1 reads and the signed image links.

import { getLocation } from "@/config/locations";
import { lookupCam } from "@/lib/camFrames/manifest";
import type { D1Like } from "@/lib/db/d1Store";
import {
  frameBySha,
  nearestFrame,
  nearestFramesAllCams,
  signedFrameUrl,
  toFrameView,
  type FrameView,
} from "@/lib/quality/frames";
import { expireOldAlerts, listOpenAlerts, listRecentAlerts, type AlertWithLabel } from "@/lib/quality/store";
import { beachName, camLabel, signalWord, statementFor } from "@/lib/quality/text";
import type {
  AlertKind,
  AlertStatus,
  HourlyAlertPayload,
  QualitySignal,
  SeaweedAlertPayload,
  Verdict,
} from "@/lib/quality/types";

/** How the "Wrong" answer is collected: a few taps, or a number. */
export type AnswerInput = "seaweed" | "clarity" | "number";

export interface AlertView {
  id: number;
  slug: string;
  beach: string;
  signal: QualitySignal;
  signalWord: string;
  kind: AlertKind;
  createdAt: string;
  status: AlertStatus;
  pushed: boolean;
  /** The sentence the card asks "Is this right?" about. */
  statement: string;
  /** What the app showed while the flag was up. */
  published: string | null;
  /** The second reading, for a seaweed alert. */
  secondOpinion: string | null;
  others: { name: string; level: string; carried: boolean }[];
  frames: FrameView[];
  /** What became of the owner push: 'sent', 'unknown' (it may not have been delivered), 'queued', or none. */
  pushState: AlertWithLabel["push_state"];
  /** The owner's answer, once given. */
  answer: { verdict: Verdict; correct: unknown } | null;
  input: AnswerInput;
  /** Unit label for a number answer ("ft", "F", ""). */
  unit: string;
}

const PROVIDER_WORDS: Record<string, string> = {
  gemini: "Gemini",
  clef: "Clef",
  groq: "Groq",
  openrouter: "OpenRouter",
  github: "GitHub Models",
};

function parse<T>(json: string): T | null {
  try {
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}

function inputFor(signal: QualitySignal): AnswerInput {
  if (signal === "seaweed") return "seaweed";
  if (signal === "clarity") return "clarity";
  return "number";
}

function unitFor(signal: QualitySignal): string {
  return signal === "surf" ? "ft" : signal === "sand" ? "F" : "";
}

/** One alert row as the screen shows it, without frames. Pure. */
export function shapeAlert(row: AlertWithLabel): AlertView | null {
  const payload = parse<SeaweedAlertPayload | HourlyAlertPayload>(row.payload_json);
  if (!payload) return null;
  const base = {
    id: row.id,
    slug: row.slug,
    beach: beachName(row.slug),
    signal: row.signal,
    signalWord: signalWord(row.signal),
    kind: row.kind,
    createdAt: row.created_at,
    status: row.status,
    pushed: row.pushed === 1,
    pushState: row.push_state ?? null,
    statement: statementFor(row.kind, row.signal, payload),
    frames: [] as FrameView[],
    answer:
      row.label_verdict != null
        ? { verdict: row.label_verdict, correct: row.label_correct ? parse<unknown>(row.label_correct) : null }
        : null,
    input: inputFor(row.signal),
    unit: unitFor(row.signal),
  };
  if (row.kind === "seaweed-held-disagreed") {
    const p = payload as SeaweedAlertPayload;
    const pub = p.published?.level;
    const second = p.secondOpinion;
    return {
      ...base,
      published: pub ? `The beach showed ${pub} seaweed while this was held.` : "Held back. The beach showed no seaweed reading from this cam.",
      secondOpinion: `A second reading (${PROVIDER_WORDS[second.provider] ?? second.provider}) says ${second.level ?? "no seaweed level"}.`,
      others: (p.others ?? []).map((o) => ({ name: camLabel(o.name), level: o.level, carried: o.carried })),
    };
  }
  return { ...base, published: null, secondOpinion: null, others: [] };
}

/** The frames for one alert: its own cam's exact frame (else the nearest), or the beach's nearest per cam. */
async function framesFor(db: D1Like, row: AlertWithLabel, view: AlertView): Promise<FrameView[]> {
  if (row.kind === "seaweed-held-disagreed") {
    const p = parse<SeaweedAlertPayload>(row.payload_json);
    if (!p) return [];
    // The exact image the reader judged, sent with the alert and kept under quality/.
    if (p.frame?.r2Key) {
      const cam = lookupCam(row.slug, p.camId);
      return [
        {
          camId: p.camId,
          url: await signedFrameUrl(p.frame.r2Key),
          takenAt: p.observedAt,
          exact: true,
          credit: cam.status === "ok" ? cam.cam.attribution : null,
        },
      ];
    }
    if (p.frame?.sha256) {
      const exact = await frameBySha(db, row.slug, p.camId, p.frame.sha256);
      if (exact) return [await toFrameView(exact, true)];
    }
    const at = Date.parse(p.observedAt);
    const near = await nearestFrame(db, row.slug, p.camId, Number.isFinite(at) ? at : Date.parse(row.created_at));
    return near ? [await toFrameView(near, false)] : [];
  }
  if (!getLocation(view.slug)?.cams?.length) return [];
  const refs = await nearestFramesAllCams(db, row.slug, Date.parse(row.created_at), 3);
  return Promise.all(refs.map((r) => toFrameView(r, false)));
}

/** Open alerts that get frames looked up (answered and expired ones show text only). */
const FRAME_LIMIT = 12;
const OPEN_LIMIT = 40;
const RECENT_LIMIT = 20;

export interface ReviewPayload {
  open: AlertView[];
  recent: AlertView[];
}

export async function loadReview(db: D1Like, nowMs: number): Promise<ReviewPayload> {
  await expireOldAlerts(db, nowMs);
  // Two queries, not one list split in two: an open alert is never buried under newer answered ones.
  const openRows = await listOpenAlerts(db, OPEN_LIMIT);
  const recentRows = await listRecentAlerts(db, RECENT_LIMIT);
  const open: AlertView[] = [];
  let looked = 0;
  for (const row of openRows) {
    const view = shapeAlert(row);
    if (!view) continue;
    if (looked < FRAME_LIMIT) {
      looked += 1;
      try {
        view.frames = await framesFor(db, row, view);
      } catch (e) {
        console.error("quality review: frame lookup failed", row.id, e);
      }
    }
    open.push(view);
  }
  const recent = recentRows.map(shapeAlert).filter((v): v is AlertView => v != null);
  return { open, recent };
}
