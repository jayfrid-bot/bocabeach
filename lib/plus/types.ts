// Client-side Beach Day Plus types. What the phone remembers between launches
// and what the Plus API answers with. Pure types — importable from anywhere.

import type { AlertPrefs, DeviceRecord } from "@/lib/db/types";
import type { ScoreProfile } from "@/lib/profile/types";

export type { AlertPrefs, DeviceRecord, ScoreProfile };

/** The entitlement the phone last read from the server (`bd:plus`). */
export interface PlusCache {
  plan: "free" | "plus";
  /** Epoch ms the entitlement runs out. Null when there has never been one. */
  until: number | null;
  /** Epoch ms of the read. Drives the 6-hour re-check. */
  checkedAt: number;
}

/** The one-time reveal, saved so the locked pill can remind people (`bd:preview`). */
export interface PreviewRecord {
  /** Beach-local calendar day of the reveal, YYYY-MM-DD. */
  date: string;
  /** Their number that day. */
  personal: number;
  /** Everyone's number that day. */
  everyone: number;
  /** What it was tuned for, e.g. "snorkeling". */
  label: string;
}
