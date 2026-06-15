import { describe, it, expect } from "vitest";
import {
  detectNoSwimAdvisory,
  parseCityConditions,
} from "@/lib/sources/cityOfficial";

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

  it("does not manufacture a red flag from same-sentence 'red tide' / 'red' adjectives", () => {
    // The flag color must read like a posted list item, not an adjective.
    for (const html of [
      `<p>Flags: Green, but watch for red tide and jellyfish.</p>`,
      `<p>Today's flag: Green, calm surf, no red tide reported.</p>`,
      `<p>Flags flying: yellow, red drum running along the pier.</p>`,
      `<p>Flags: yellow and purple, currents strong near Red Rock jetty.</p>`,
    ]) {
      expect(parseCityConditions(html).flags).not.toContain("red");
    }
    // ...but a genuinely posted red flag (and double-red) is still detected.
    expect(parseCityConditions(`<p>Today's flags: Red (High).</p>`).flags).toContain("red");
    expect(
      parseCityConditions(`<p>Double red flag flying — water closed.</p>`).flags,
    ).toContain("double-red");
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

  it("detects a City no-swim advisory from the AlertCenter bar", () => {
    // Mirrors the real myboca.us site-wide alert bar markup.
    const bar = `
      <a href="/AlertCenter.aspx" id="1_lnkAlertText" class="alertText">
        <span class="customAlert">NO SWIM Alert</span></a>
      <span class="alertContainer"><a
        href="/AlertCenter.aspx?AID=NO-SWIM-ADVISORY-for-Spanish-River-Beach-112"
        class="alert"> NO SWIM ADVISORY for Spanish River Beach
        <span style="color:#FC4C2F;">Read On...</span></a></span>`;
    const adv = detectNoSwimAdvisory(bar);
    expect(adv?.title).toBe("NO SWIM ADVISORY for Spanish River Beach");
    expect(adv?.url).toBe(
      "https://www.myboca.us/AlertCenter.aspx?AID=NO-SWIM-ADVISORY-for-Spanish-River-Beach-112",
    );
  });

  it("does NOT treat a lifted/rescinded advisory as active", () => {
    // The real myboca.us bar when the advisory is over — must not surface it.
    const lifted = `
      <span class="alertContainer"><a
        href="/AlertCenter.aspx?AID=SWIM-ADVISORY-LIFTED-for-Spanish-River-B-113"
        class="alert"> SWIM ADVISORY LIFTED for Spanish River Beach
        <span style="color:#FC4C2F;">Read On...</span></a></span>`;
    expect(detectNoSwimAdvisory(lifted)).toBeUndefined();

    const rescinded = `<a href="/AlertCenter.aspx?AID=water-advisory-9"
      class="alert">Water Contact Advisory Rescinded Read On...</a>`;
    expect(detectNoSwimAdvisory(rescinded)).toBeUndefined();
  });

  it("ignores unrelated AlertCenter alerts and absence of any", () => {
    const unrelated = `<a href="/AlertCenter.aspx?AID=Sanitation-Schedule-Change-9"
      class="alert">Sanitation Schedule Change Read On...</a>`;
    expect(detectNoSwimAdvisory(unrelated)).toBeUndefined();
    expect(detectNoSwimAdvisory("<p>no alert bar here</p>")).toBeUndefined();
  });

  it("extracts the City's posted update label", () => {
    expect(parseCityConditions(HTML).updatedLabel).toBe(
      "Tuesday June 2, 2026 (Update 10:00 am)",
    );
    // Absent label -> undefined, not a crash.
    expect(parseCityConditions("<p>Flags: Green</p>").updatedLabel).toBeUndefined();
  });
});
