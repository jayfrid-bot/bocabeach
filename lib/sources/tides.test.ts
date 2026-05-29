import { describe, it, expect } from "vitest";
import { parseNoaaPredictions } from "@/lib/sources/tides";

const JSON_OK = {
  predictions: [
    { t: "2026-05-29 06:00", v: "0.3", type: "L" as const },
    { t: "2026-05-29 12:29", v: "2.5", type: "H" as const },
    { t: "2026-05-29 18:55", v: "0.2", type: "L" as const },
  ],
};

describe("parseNoaaPredictions", () => {
  it("keeps only upcoming events and infers trend", () => {
    const now = Date.parse("2026-05-29T09:00:00Z");
    const d = parseNoaaPredictions(JSON_OK, now);
    expect(d).not.toBeNull();
    expect(d!.next).toHaveLength(2);
    expect(d!.next[0].type).toBe("high");
    expect(d!.next[0].heightFt).toBe(2.5);
    expect(d!.trend).toBe("rising"); // next event is a high tide
  });

  it("reports falling when the next event is a low tide", () => {
    const now = Date.parse("2026-05-29T13:00:00Z");
    const d = parseNoaaPredictions(JSON_OK, now);
    expect(d!.next[0].type).toBe("low");
    expect(d!.trend).toBe("falling");
  });

  it("returns null on an API error payload", () => {
    expect(parseNoaaPredictions({ error: { message: "bad station" } })).toBeNull();
  });
});
