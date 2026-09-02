// Words for the settings sheet: one short label per scoring factor and one per
// alert. Kept here (not in a component) so the copy is testable and there is a
// single place to change what any of it is called.

import { ALERT_KEYS, type AlertKey } from "@/lib/db/types";
import type { FactorMultiplier, SubKey } from "@/lib/profile/types";

/** Advanced-mode rows, in the order they read best. */
export const FACTOR_ORDER: SubKey[] = [
  "airTemp",
  "sky",
  "wind",
  "waves",
  "waterTemp",
  "clarity",
  "comfort",
  "sandTemp",
  "sargassum",
  "crowds",
  "uv",
];

export const FACTOR_LABELS: Record<SubKey, string> = {
  airTemp: "Air temperature",
  sky: "Sun and sky",
  wind: "Wind",
  waves: "Waves",
  waterTemp: "Water temperature",
  clarity: "Water clarity",
  comfort: "Mugginess",
  sandTemp: "Sand temperature",
  sargassum: "Seaweed",
  crowds: "Crowds",
  uv: "UV index",
};

/** The five stops, in order. The value multiplies the profile's own weight. */
export const MULTIPLIER_STOPS: { value: FactorMultiplier; label: string }[] = [
  { value: 0, label: "Doesn't matter" },
  { value: 0.5, label: "A little" },
  { value: 1, label: "Normal" },
  { value: 2, label: "A lot" },
  { value: 3, label: "Essential" },
];

/** Alert rows: what each toggle actually sends. */
export const ALERT_LABELS: Record<AlertKey, string> = {
  lightning: "Lightning within 5 miles",
  thunder: "Thunderstorm approaching",
  severe: "Severe weather warning",
  "rain-soon": "Rain starting soon",
  "rain-clearing": "Rain clearing",
  "wind-gust": "Wind gusting",
  flag: "Beach flag changes",
  rip: "High rip current risk",
  "water-advisory": "Water quality advisory",
  morning: "Morning beach summary",
  "score-excellent": "Your score turns Excellent",
};

/** At-the-beach alerts first, then the daily ones. */
export const ALERT_GROUPS: { title: string; keys: AlertKey[] }[] = [
  {
    title: "At the beach",
    keys: ["lightning", "thunder", "severe", "rain-soon", "rain-clearing", "wind-gust", "flag", "rip", "water-advisory"],
  },
  { title: "Every day", keys: ["morning", "score-excellent"] },
];

/** Every alert key is in exactly one group — guards a future key being added
 *  to lib/db/types.ts without a home in the settings sheet. */
export function ungroupedAlertKeys(): AlertKey[] {
  const grouped = new Set(ALERT_GROUPS.flatMap((g) => g.keys));
  return ALERT_KEYS.filter((k) => !grouped.has(k));
}
