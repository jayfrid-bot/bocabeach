import { describe, it, expect } from "vitest";
import { expectedNextCamRead } from "@/lib/camNextRead";

const TZ = "America/New_York";

/** Build ISO local timestamps (fixed -04:00 offset, EDT) for a given local date. */
function iso(dateStr: string, hour: number, minute: number): string {
  const hh = String(hour).padStart(2, "0");
  const mm = String(minute).padStart(2, "0");
  return `${dateStr}T${hh}:${mm}:00-04:00`;
}

/** The N local calendar dates immediately before `todayStr` (EDT, no DST edge). */
function priorDates(todayStr: string, n: number): string[] {
  const out: string[] = [];
  const d = new Date(`${todayStr}T12:00:00-04:00`);
  for (let i = 1; i <= n; i++) {
    const p = new Date(d.getTime() - i * 24 * 60 * 60_000);
    out.push(p.toISOString().slice(0, 10));
  }
  return out;
}

describe("expectedNextCamRead", () => {
  it("returns null with fewer than 5 days of matching history", () => {
    const today = "2026-09-23";
    const now = new Date(iso(today, 14, 0));
    const days = priorDates(today, 3);
    const reads = days.map((d) => iso(d, 14, 5));
    expect(expectedNextCamRead(reads, now, TZ)).toBeNull();
  });

  it("returns null with no history at all", () => {
    const now = new Date(iso("2026-09-23", 14, 0));
    expect(expectedNextCamRead([], now, TZ)).toBeNull();
  });

  it("steady ~10-minute cadence -> ~10 minute estimate", () => {
    const today = "2026-09-23";
    const now = new Date(iso(today, 14, 0));
    const days = priorDates(today, 14);
    // Every day, a read lands 10 minutes after the target time-of-day.
    const reads = days.map((d) => iso(d, 14, 10));
    const result = expectedNextCamRead(reads, now, TZ);
    expect(result).not.toBeNull();
    expect(result!.basisDays).toBe(14);
    const deltaMin = (new Date(result!.iso).getTime() - now.getTime()) / 60_000;
    // now + 10 min = 14:10, already a 5-min mark -> rounds to itself.
    expect(deltaMin).toBe(10);
  });

  it("midday-gap day pattern: some days have a long midday gap, median still holds", () => {
    const today = "2026-09-23";
    const now = new Date(iso(today, 13, 0));
    const days = priorDates(today, 10);
    // 8 days: quick 8-minute read. 2 days: a big midday gap, read lands 3h later.
    const reads = days.map((d, i) => (i < 8 ? iso(d, 13, 8) : iso(d, 16, 0)));
    const result = expectedNextCamRead(reads, now, TZ);
    expect(result).not.toBeNull();
    expect(result!.basisDays).toBe(10);
    const deltaMin = (new Date(result!.iso).getTime() - now.getTime()) / 60_000;
    // Median of eight 8-minute delays and two 180-minute delays -> 8 minutes,
    // rounded up to the next 5-minute mark = 10.
    expect(deltaMin).toBe(10);
  });

  it("evening after the last read -> estimates next morning", () => {
    const today = "2026-09-23";
    const now = new Date(iso(today, 21, 0)); // 9 PM, well after cams stop for the night
    const days = priorDates(today, 6);
    // Each prior day: last evening read at 20:55, next read at 06:30 the following morning.
    const reads: string[] = [];
    for (const d of days) {
      const next = new Date(new Date(`${d}T12:00:00-04:00`).getTime() + 24 * 60 * 60_000)
        .toISOString()
        .slice(0, 10);
      reads.push(iso(next, 6, 30));
    }
    const result = expectedNextCamRead(reads, now, TZ);
    expect(result).not.toBeNull();
    expect(result!.basisDays).toBe(6);
    const resultDate = new Date(result!.iso);
    const local = new Intl.DateTimeFormat("en-US", {
      timeZone: TZ,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(resultDate);
    expect(local).toBe("06:30");
  });

  it("rounds the estimate up to the next 5 minutes", () => {
    const today = "2026-09-23";
    const now = new Date(iso(today, 14, 0));
    const days = priorDates(today, 5);
    // Delay of exactly 7 minutes every day -> now+7min, rounds up to now+10min.
    const reads = days.map((d) => iso(d, 14, 7));
    const result = expectedNextCamRead(reads, now, TZ);
    expect(result).not.toBeNull();
    const deltaMin = (new Date(result!.iso).getTime() - now.getTime()) / 60_000;
    expect(deltaMin).toBe(10);
  });

  it("handles a DST transition week without throwing and returns a sane estimate", () => {
    // US fall-back DST ends 2026-11-01. Use the week straddling it.
    const today = "2026-11-05";
    const now = new Date(`${today}T14:00:00-05:00`); // EST, after the fall-back
    const days = ["2026-11-04", "2026-11-03", "2026-11-02", "2026-11-01", "2026-10-31", "2026-10-30"];
    const reads = days.map((d) => {
      // Days before the transition (10-31, 10-30) were still EDT (-04:00);
      // from 11-01 onward it's EST (-05:00). Use the correct offset per day.
      const isEdt = d < "2026-11-01";
      const off = isEdt ? "-04:00" : "-05:00";
      return `${d}T14:12:00${off}`;
    });
    const result = expectedNextCamRead(reads, now, TZ);
    expect(result).not.toBeNull();
    expect(result!.basisDays).toBe(6);
    const deltaMin = (new Date(result!.iso).getTime() - now.getTime()) / 60_000;
    expect(deltaMin).toBeGreaterThanOrEqual(10);
    expect(deltaMin).toBeLessThan(20);
  });

  // --- DST correctness: the 14-day lookback straddles a real transition ----
  // US 2026 spring-forward: 2026-03-08, 2:00 AM EST -> 3:00 AM EDT (the hour
  // 2:00-2:59 never happens). US 2026 fall-back: 2026-11-01, 2:00 AM EDT ->
  // 1:00 AM EST (the hour 1:00-1:59 happens twice).

  it("spring-forward: a lookback day landing on the missing hour uses the first valid instant after it", () => {
    // "now"'s time-of-day is 02:35 — a nominal wall-clock time that simply
    // does not exist on 2026-03-08 (the gap is 02:00-03:00). Every day in the
    // 14-day lookback (2026-03-01 .. 2026-03-14) gets a read 5 minutes after
    // its own version of that target; 2026-03-08's target resolves to 03:35
    // EDT (the gap's width, one hour, shifted forward), so its read is
    // 03:40 EDT.
    const now = new Date("2026-03-15T02:35:00-04:00"); // 7 days after the transition, EDT
    const reads: string[] = [];
    for (let day = 1; day <= 7; day++) {
      // 2026-03-01 .. 2026-03-07: still EST.
      reads.push(`2026-03-0${day}T02:40:00-05:00`);
    }
    reads.push("2026-03-08T03:40:00-04:00"); // the gap day — resolved target + 5 min
    for (let day = 9; day <= 14; day++) {
      // 2026-03-09 .. 2026-03-14: already EDT.
      const d = day < 10 ? `0${day}` : `${day}`;
      reads.push(`2026-03-${d}T02:40:00-04:00`);
    }
    const result = expectedNextCamRead(reads, now, TZ);
    expect(result).not.toBeNull();
    expect(result!.basisDays).toBe(14);
    // Every day (including the gap day) contributed exactly a 5-minute delay.
    expect(result!.iso).toBe(new Date("2026-03-15T02:40:00-04:00").toISOString());
  });

  it("fall-back: a lookback day landing on the repeated hour uses the earlier occurrence", () => {
    // "now"'s time-of-day is 01:30 — a wall-clock time that happens TWICE on
    // 2026-11-01 (once at 01:30 EDT, once at 01:30 EST, an hour later in real
    // time). Every day in the 14-day lookback (2026-10-25 .. 2026-11-07) gets
    // a read 5 minutes after its own version of that target; 2026-11-01's
    // target resolves to the EARLIER occurrence, 01:30 EDT, so its read is
    // 01:35 EDT (not the later 01:35 EST).
    const now = new Date("2026-11-08T01:30:00-05:00"); // 7 days after the transition, EST
    const reads: string[] = [];
    for (let day = 25; day <= 31; day++) {
      // 2026-10-25 .. 2026-10-31: still EDT.
      reads.push(`2026-10-${day}T01:35:00-04:00`);
    }
    reads.push("2026-11-01T01:35:00-04:00"); // the ambiguous day — EARLIER (EDT) occurrence + 5 min
    for (let day = 2; day <= 7; day++) {
      // 2026-11-02 .. 2026-11-07: already EST.
      const d = day < 10 ? `0${day}` : `${day}`;
      reads.push(`2026-11-${d}T01:35:00-05:00`);
    }
    const result = expectedNextCamRead(reads, now, TZ);
    expect(result).not.toBeNull();
    expect(result!.basisDays).toBe(14);
    expect(result!.iso).toBe(new Date("2026-11-08T01:35:00-05:00").toISOString());
  });

  // --- Stale feed guard -------------------------------------------------

  it("refuses to estimate when the newest read is more than 36h old (dead feed)", () => {
    const today = "2026-09-23";
    const now = new Date(iso(today, 14, 0));
    // A perfectly good steady 14-day cadence (10-min delay each day)...
    const freshReads = priorDates(today, 14).map((d) => iso(d, 14, 10));
    // Sanity: unshifted, this history DOES produce an estimate.
    expect(expectedNextCamRead(freshReads, now, TZ)).not.toBeNull();
    // ...but shifted back 40h, even the newest read is stale relative to "now".
    const staleReads = freshReads.map((r) =>
      new Date(new Date(r).getTime() - 40 * 60 * 60_000).toISOString(),
    );
    expect(expectedNextCamRead(staleReads, now, TZ)).toBeNull();
  });

  it("never reads today's own history as a prior day", () => {
    const today = "2026-09-23";
    const now = new Date(iso(today, 14, 0));
    // Only today's reads exist -> no prior days matched -> null.
    const reads = [iso(today, 13, 0), iso(today, 14, 5)];
    expect(expectedNextCamRead(reads, now, TZ)).toBeNull();
  });
});
