import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { CHANGELOG } from "@/lib/changelog";

// The changelog file was created (with backfilled history) on this date. Entries
// dated before it are legitimately backdated from git history and are exempt.
const CHANGELOG_BORN = "2026-07-24";

/** Date (YYYY-MM-DD, local) of the FIRST commit that added this exact title line.
 *  Corrections to an entry's `date` don't move this, so the check survives fixes. */
function firstAddDate(title: string): string | null {
  try {
    const out = execSync(
      `git log --reverse --format=%ad --date=short -S${JSON.stringify(title)} -- lib/changelog.ts`,
      { cwd: process.cwd(), stdio: ["ignore", "pipe", "ignore"] },
    )
      .toString()
      .trim();
    const first = out.split("\n").find((l) => /^\d{4}-\d{2}-\d{2}$/.test(l.trim()));
    return first ? first.trim() : null;
  } catch {
    return null;
  }
}

function dayDiff(a: string, b: string): number {
  return Math.round((Date.parse(a) - Date.parse(b)) / 86_400_000);
}

// Guard against the bug that actually happened: hand-typing an entry's date from a
// session clock that had drifted weeks behind the real calendar. Each committed
// entry's date must be within a day of the commit that introduced it. Uncommitted
// entries (no git record yet) are skipped here — they get checked on the next run.
describe("changelog dates match git", () => {
  const recent = CHANGELOG.filter((e) => e.date >= CHANGELOG_BORN);

  it("every committed entry is dated within a day of the commit that added it", () => {
    const mismatches: string[] = [];
    for (const e of recent) {
      if (e.backfilled) continue; // checked separately below
      const added = firstAddDate(e.title);
      if (!added) continue; // not committed yet, or git unavailable
      if (Math.abs(dayDiff(e.date, added)) > 1) {
        mismatches.push(`"${e.title}" dated ${e.date} but first committed ${added}`);
      }
    }
    expect(mismatches, mismatches.join("\n")).toEqual([]);
  });

  it("backfilled entries are dated on a day that has real commits", () => {
    const bad: string[] = [];
    for (const e of recent.filter((x) => x.backfilled)) {
      let count = 0;
      try {
        count = execSync(
          `git log --format=%h --since="${e.date} 00:00" --until="${e.date} 23:59:59"`,
          { cwd: process.cwd(), stdio: ["ignore", "pipe", "ignore"] },
        )
          .toString()
          .trim()
          .split("\n")
          .filter(Boolean).length;
      } catch {
        continue; // git unavailable
      }
      if (count === 0) bad.push(`"${e.title}" backfilled to ${e.date}, but nothing was committed that day`);
    }
    expect(bad, bad.join("\n")).toEqual([]);
  });
});
