// The one quiet line that says the scoring formula changed inside the days on
// screen. Pure. Lives here (not in components/plus/HistorySection.tsx) so the
// day sheet can use it without importing the section that opens the sheet;
// HistorySection re-exports it for its existing callers and tests.

import { shortMonthDay, type HistoryVersions } from "@/lib/history/summary";
import { findScoringVersion } from "@/lib/scoringVersions";

/** The one quiet line under the strip when the shown days cross a formula
 *  change: names the most recent change, and "and earlier" when there are
 *  more. Also covers a range scored wholly by older formulas (right after a
 *  change, before any new row exists). Null when nothing needs saying. */
export function formulaChangeNotice(versions: HistoryVersions | null): string | null {
  if (!versions) return null;
  const dates = [...new Set(versions.boundaries.map((b) => b.date))].sort();
  if (dates.length > 1) {
    return `Scoring changed on ${shortMonthDay(dates[dates.length - 1])} and earlier — days before that were scored by earlier formulas.`;
  }
  if (dates.length === 1) {
    return `Scoring changed on ${shortMonthDay(dates[0])} — days before that were scored by an earlier formula.`;
  }
  const since = findScoringVersion(versions.current)?.since;
  if (since && versions.inRange.length > 0 && !versions.inRange.includes(versions.current)) {
    return `Scoring changed on ${shortMonthDay(since)} — these days were scored by an earlier formula.`;
  }
  return null;
}
