import { describe, it, expect } from "vitest";
import { parseCityConditions } from "@/lib/sources/cityOfficial";

// Mirrors the structure of myboca.us/2464/Beach-Conditions.
const HTML = `
<html><body>
  <h1>Beach Conditions</h1>
  <p>Tuesday June 2, 2026 (Update 10:00 am)</p>
  <p>Today's flags: Yellow (Medium) and Purple (Sea Pest).</p>
  <p>Swimming rated 'Fair'. Snorkeling rated 'Fair'. Surfing rated 'Poor: Unrideable'.</p>
  <p>Jellyfish reported. Seaweed along the shoreline. Underlying rip currents present.</p>
</body></html>`;

describe("parseCityConditions", () => {
  it("detects multiple flags without false 'red' positives", () => {
    const d = parseCityConditions(HTML);
    expect(d.flags).toContain("purple");
    expect(d.flags).toContain("yellow");
    expect(d.flags).not.toContain("red");
  });

  it("extracts lifeguard activity ratings", () => {
    const d = parseCityConditions(HTML);
    expect(d.swimmingRating).toBe("Fair");
    expect(d.snorkelingRating).toBe("Fair");
    expect(d.surfingRating).toBe("Poor");
  });

  it("does not mistake 'Red Reef Beach' for a red flag", () => {
    const html = `
      <p>Flags flying: Yellow (Medium) and Purple (Sea Pest).</p>
      <p>Hazard: strong currents around the rocks at Red Reef Beach.</p>`;
    const d = parseCityConditions(html);
    expect(d.flags).not.toContain("red");
    expect(d.flags).toContain("yellow");
    expect(d.flags).toContain("purple");
  });

  it("picks up marine life and hazards", () => {
    const d = parseCityConditions(HTML);
    expect(d.marineLife).toContain("jellyfish");
    expect(d.marineLife).toContain("seaweed");
    expect(d.hazards).toContain("rip currents");
  });

  it("extracts the City's posted update label", () => {
    expect(parseCityConditions(HTML).updatedLabel).toBe(
      "Tuesday June 2, 2026 (Update 10:00 am)",
    );
    // Absent label -> undefined, not a crash.
    expect(parseCityConditions("<p>Flags: Green</p>").updatedLabel).toBeUndefined();
  });
});
