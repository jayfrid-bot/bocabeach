import { describe, it, expect, vi, afterEach } from "vitest";
import {
  detectNoSwimAdvisory,
  parseCityConditions,
  mapFlagsFeed,
  fetchCityOfficial,
} from "@/lib/sources/cityOfficial";
import type { Location } from "@/lib/types";

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

  // Regression, 2026-07-29: the City added a standing note that double reds
  // "may be flown at times" during lightning. Read as a posting it pinned the
  // Beach Day score at the double-red cap (5) all day while yellow/purple were
  // the flags actually up. A hedged clause is a forecast, not a posting.
  it("ignores a conditional double-red note and reads the flags actually flying", () => {
    const html = `<html><body>
      <h3>Flags</h3>
      <p>Yellow (Medium) Hazard And Purple (Sea Pest) Flags:</p>
      <p>Double Red Flags May Be Flown At Times Due To Lightning In The Area: Please Clear The Beach If Directed</p>
    </body></html>`;
    const d = parseCityConditions(html);
    expect(d.flags).not.toContain("double-red");
    expect(d.flags).not.toContain("red");
    expect(d.flags).toEqual(expect.arrayContaining(["yellow", "purple"]));
  });

  it("still posts a real double-red when it is stated as fact", () => {
    const d = parseCityConditions(
      `<html><body><p>Double red flags are flying. Beach closed to swimming.</p></body></html>`,
    );
    expect(d.flags).toContain("double-red");
    expect(d.flags).not.toContain("red");
  });

  it("still posts a plain red flag stated as fact", () => {
    const d = parseCityConditions(`<html><body><p>Red flag: high hazard surf.</p></body></html>`);
    expect(d.flags).toContain("red");
  });

  it("does not post a flag for hedged single-red wording", () => {
    const d = parseCityConditions(
      `<html><body><p>Red flags may be posted if conditions deteriorate.</p></body></html>`,
    );
    expect(d.flags).not.toContain("red");
  });

  it("does not treat 'red tide' near a flags anchor as a red flag", () => {
    const d = parseCityConditions(
      `<html><body><p>Watch for red tide near the flags. Green flag today.</p></body></html>`,
    );
    expect(d.flags).not.toContain("red");
    expect(d.flags).toContain("green");
  });
});

// --- Deerfield Beach's flags-feed path (Location.flagsFeedUrl) -------------

const NOW = new Date("2026-09-14T18:00:00Z");

describe("mapFlagsFeed", () => {
  it("reports a fresh single flag as-is", () => {
    const d = mapFlagsFeed(
      { flags: ["yellow"], observedAtUtc: "2026-09-14T17:45:00Z", ok: true },
      NOW,
    );
    expect(d.flags).toEqual(["yellow"]);
  });

  it("reports a fresh purple+yellow combination", () => {
    const d = mapFlagsFeed(
      { flags: ["purple", "yellow"], observedAtUtc: "2026-09-14T17:45:00Z", ok: true },
      NOW,
    );
    expect(d.flags).toEqual(expect.arrayContaining(["purple", "yellow"]));
    expect(d.flags).toHaveLength(2);
  });

  it("degrades a stale reading (> 6h old) to unknown, not a cap", () => {
    const d = mapFlagsFeed(
      { flags: ["double-red"], observedAtUtc: "2026-09-14T11:00:00Z", ok: true },
      NOW,
    );
    expect(d.flags).toEqual(["unknown"]);
  });

  it("degrades an explicit ok:false reading to unknown, regardless of freshness", () => {
    const d = mapFlagsFeed(
      { flags: ["red"], observedAtUtc: "2026-09-14T17:59:00Z", ok: false, error: "scrape failed" },
      NOW,
    );
    expect(d.flags).toEqual(["unknown"]);
  });

  it("drops unrecognized flag values and falls back to unknown if none survive", () => {
    const d = mapFlagsFeed(
      { flags: ["chartreuse"], observedAtUtc: "2026-09-14T17:45:00Z", ok: true },
      NOW,
    );
    expect(d.flags).toEqual(["unknown"]);
  });

  it("treats a missing/unparsable observedAtUtc as stale", () => {
    expect(mapFlagsFeed({ flags: ["green"], ok: true }, NOW).flags).toEqual(["unknown"]);
    expect(
      mapFlagsFeed({ flags: ["green"], observedAtUtc: "not-a-date", ok: true }, NOW).flags,
    ).toEqual(["unknown"]);
  });
});

const DEERFIELD_LOCATION: Location = {
  slug: "deerfield-beach",
  name: "Deerfield Beach",
  region: "Broward County, FL",
  lat: 26.3165,
  lon: -80.0742,
  timezone: "America/New_York",
  noaaTideStationId: "8722832",
  ndbcBuoyId: "41122",
  cams: [],
  cityConditionsUrl: "https://www.deerfield-beach.com/286/Beach-Conditions-and-Flags",
  cityConditionsAttribution: "City of Deerfield Beach Ocean Rescue",
  flagsFeedUrl: "https://uw-frame.entwined-app.workers.dev/flags?slug=deerfield-beach",
};

const BOCA_LOCATION: Location = {
  slug: "boca-raton",
  name: "Boca Raton",
  region: "Palm Beach County, FL",
  lat: 26.3587,
  lon: -80.0686,
  timezone: "America/New_York",
  noaaTideStationId: "8722816",
  ndbcBuoyId: "LKWF1",
  cams: [],
  cityConditionsUrl: "https://www.myboca.us/2464/Beach-Conditions",
  cityConditionsAttribution: "City of Boca Raton Ocean Rescue (myboca.us)",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("fetchCityOfficial — flags-feed beaches (e.g. Deerfield)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reads a fresh flags feed instead of scraping cityConditionsUrl", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse({
        flags: ["purple", "yellow"],
        observedAtUtc: new Date().toISOString(),
        ok: true,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const w = await fetchCityOfficial(DEERFIELD_LOCATION);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(DEERFIELD_LOCATION.flagsFeedUrl);
    expect(w.data?.flags).toEqual(expect.arrayContaining(["purple", "yellow"]));
    expect(w.attribution).toBe("City of Deerfield Beach Ocean Rescue");
    expect(w.status).toBe("ok");
  });

  it("degrades a stale flags feed to unknown without throwing", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse({
        flags: ["red"],
        observedAtUtc: "2020-01-01T00:00:00Z", // ancient — always stale
        ok: true,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const w = await fetchCityOfficial(DEERFIELD_LOCATION);

    expect(w.data?.flags).toEqual(["unknown"]);
    expect(w.status).toBe("stale");
  });

  it("never throws on a network/parse failure — degrades to unknown", async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock);

    const w = await fetchCityOfficial(DEERFIELD_LOCATION);

    expect(w.data?.flags).toEqual(["unknown"]);
    expect(w.status).toBe("error");
    expect(w.note).toMatch(/network down/);
  });

  it("degrades to unknown on a non-ok HTTP response, without throwing", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response("nope", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    const w = await fetchCityOfficial(DEERFIELD_LOCATION);

    expect(w.data?.flags).toEqual(["unknown"]);
    expect(w.status).toBe("error");
  });

  it("leaves Boca's HTML scrape path unchanged", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(HTML, { status: 200, headers: { "content-type": "text/html" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const w = await fetchCityOfficial(BOCA_LOCATION);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(BOCA_LOCATION.cityConditionsUrl);
    expect(w.attribution).toBe("City of Boca Raton Ocean Rescue (myboca.us)");
    expect(w.status).toBe("best-effort");
    expect(w.data?.flags).toEqual(expect.arrayContaining(["purple", "yellow"]));
    expect(w.data?.swimmingRating).toBe("Fair");
  });
});
