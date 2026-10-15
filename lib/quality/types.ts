// Shared shapes for the data-quality loop (docs/QUALITY_PLAN.md,
// migrations/0019_quality_loop.sql). Row types are snake_case, mirroring the
// D1 columns; everything the owner screens read is camelCase JSON.

export const SIGNALS = ["seaweed", "clarity", "surf", "sand", "score", "crowd", "other"] as const;
export type QualitySignal = (typeof SIGNALS)[number];

export type AlertKind = "seaweed-held-disagreed" | "hourly-jump";
export type AlertStatus = "open" | "answered" | "expired";
export type LabelSource = "alert" | "report";
export type Verdict = "right" | "wrong";

/** The seaweed words the reader and the owner use. */
export const SEAWEED_LEVELS = ["none", "low", "moderate", "high"] as const;
export type SeaweedLevel = (typeof SEAWEED_LEVELS)[number];

/** The clarity words on the owner screens (the app's own grades are 0-100). */
export const CLARITY_WORDS = ["clear", "slightly_murky", "murky"] as const;
export type ClarityWord = (typeof CLARITY_WORDS)[number];

export function isSignal(v: unknown): v is QualitySignal {
  return typeof v === "string" && (SIGNALS as readonly string[]).includes(v);
}
export function isSeaweedLevel(v: unknown): v is SeaweedLevel {
  return typeof v === "string" && (SEAWEED_LEVELS as readonly string[]).includes(v);
}
export function isClarityWord(v: unknown): v is ClarityWord {
  return typeof v === "string" && (CLARITY_WORDS as readonly string[]).includes(v);
}

export interface AlertRow {
  id: number;
  slug: string;
  signal: QualitySignal;
  kind: AlertKind;
  created_at: string;
  payload_json: string;
  status: AlertStatus;
  label_id: number | null;
  dedupe_key: string;
  pushed: 0 | 1;
}

export interface LabelRow {
  id: number;
  alert_id: number | null;
  superseded: 0 | 1;
  slug: string;
  signal: QualitySignal;
  observed_at_utc: string;
  source: LabelSource;
  published_value: string | null;
  claimed_value: string | null;
  verdict: Verdict | null;
  correct_value: string | null;
  cam_id: string | null;
  r2_key: string | null;
  frames_json: string | null;
  note: string | null;
  created_at: string;
}

/** What an owner verdict does to the claim it names. */
export type OverrideAction = "publish" | "reject";

/** One stored owner verdict on one exact seaweed claim (migrations/0019 `quality_overrides`). */
export interface OverrideRow {
  id: number;
  alert_id: number;
  label_id: number | null;
  superseded: 0 | 1;
  slug: string;
  signal: QualitySignal;
  cam_id: string;
  frame_sha: string | null;
  frame_at: string | null;
  claimed_at: string | null;
  local_date: string;
  verdict: Verdict;
  action: OverrideAction;
  level: SeaweedLevel | null;
  coverage_pct: number | null;
  note: string | null;
  created_at_utc: string;
  until_utc: string;
}

/** The identity of one claim: the cam, the frame (hash for feed cams, else the frame's time), and when it was scored. */
export interface ClaimTarget {
  frameSha: string | null;
  frameAt: string | null;
  claimedAt: string | null;
}

/** One other cam's current reading, as the reader saw it when it flagged a cam. */
export interface OtherCamReading {
  id: string;
  name: string;
  level: SeaweedLevel;
  coveragePct: number | null;
  carried: boolean;
}

/** The `payload_json` of a 'seaweed-held-disagreed' alert. */
export interface SeaweedAlertPayload {
  camId: string;
  camName: string;
  /** The frame's own time (else the scoring time), ISO UTC. */
  observedAt: string;
  /** What the beach roll-up published while the claim was held. */
  published: { level: SeaweedLevel | null; pct: number | null } | null;
  claim: { level: SeaweedLevel; coveragePct: number | null; note: string | null; provider: string | null; model: string | null };
  secondOpinion: { provider: string; model: string | null; level: SeaweedLevel | null; coveragePct: number | null; note: string | null };
  others: OtherCamReading[];
  /** The exact claim this alert is about; an owner verdict binds to it, never to the cam in general. */
  claimTarget: ClaimTarget;
  /** The beach-local date of the claim (YYYY-MM-DD). A verdict acts live only on that same day. */
  localDate: string;
  /**
   * The exact image: its SHA-256 (hex, of the original still), whether the archive took it
   * this tick, and `r2Key`, the shrunk copy sent with the alert and kept under `quality/`
   * (null when none was sent or it could not be stored).
   */
  frame: { sha256: string | null; archivedThisTick: boolean; r2Key?: string | null };
}

/** The `payload_json` of an 'hourly-jump' alert. */
export interface HourlyAlertPayload {
  /** The beach-local date of the hour the jump was seen in. */
  localDate?: string;
  /** The hour the jump was seen in (hour_utc of the new row). */
  observedAt: string;
  fromHourUtc: string;
  from: number;
  to: number;
  delta: number;
  /** Which input moved the score most (score jumps only). */
  cause: { key: string; label: string; delta: number } | null;
  /** What the app showed in the new hour. */
  published: { value: number };
}

export type AlertPayload = SeaweedAlertPayload | HourlyAlertPayload;
