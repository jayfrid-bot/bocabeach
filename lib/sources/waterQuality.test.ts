import { describe, it, expect } from "vitest";
import {
  parseHealthyBeaches,
  parseTotalRecords,
  rateEnterococci,
  summarizeWaterQuality,
} from "@/lib/sources/waterQuality";

/**
 * Mirrors a row of the FL Healthy Beaches Caspio DataPage: per-site cells plus
 * the inline `var enterococcus = '<cfu>'` script, an Advisory Yes/No cell, and
 * the map/info cells (which use "Advisory: 0/-1" and "Sample Date:" — these must
 * NOT be mistaken for the real Date/Advisory columns).
 */
function row(opts: {
  location: string;
  date: string; // M/D/YYYY
  ent: string; // raw value, e.g. "10" or "NR"
  advisory: "Yes" | "No";
}): string {
  const advBit = opts.advisory === "Yes" ? "-1" : "0";
  return `
  <tr class="cbResultSetDataRow">
    <td class="cbResultSetTableCell"><span class="cbResultSetLabel">Period:</span> 1297</td>
    <td class="cbResultSetTableCell"><span class="cbResultSetLabel">Location:</span> ${opts.location}</td>
    <td class="cbResultSetTableCell"><span class="cbResultSetLabel">Date:</span> ${opts.date}</td>
    <td class="cbResultSetTableCell"><script>var ec_GeoMean = ''; if (ec_GeoMean<36){} </script></td>
    <td class="cbResultSetTableCell"><span class="cbResultSetLabel">Enterococcus Code (calc):</span>
      <script>var enterococcus = '${opts.ent}'; if (enterococcus<=35.4){} else if (enterococcus>=70.5){}</script>
      <span id="enterococcus-cb8a1-1"></span></td>
    <td class="cbResultSetTableCell"><script>var fecalColiform = '';</script></td>
    <td class="cbResultSetTableCell"><span class="cbResultSetLabel">Advisory:</span> ${opts.advisory}</td>
    <td class="cbResultSetTableCell"><span class="cbResultSetLabel">?:</span> Advisory *A Poor rating may result in a resampling event.</td>
    <td class="cbResultSetTableCell">${opts.location} Period: 1297 SPNo: Sample Date: 0${opts.date} Advisory: ${advBit} View Samples 26.38 -80.06</td>
    <td class="cbResultSetTableCell">View Samples</td>
  </tr>`;
}

const PAGE = `
<html><body>
  <table class="cbResultSetTable">
    <thead><tr><td class="cbResultSetHeaderCell">Period</td><td class="cbResultSetHeaderCell">Location</td>
      <td class="cbResultSetHeaderCell">Date</td><td class="cbResultSetHeaderCell">Enterococcus Code (calc)</td>
      <td class="cbResultSetHeaderCell">Advisory</td></tr></thead>
    <tbody>
      ${row({ location: "SPANISH RIVER", date: "5/18/2026", ent: "20", advisory: "No" })}
      ${row({ location: "SPANISH RIVER", date: "5/26/2026", ent: "10", advisory: "No" })}
      ${row({ location: "SOUTH INLET PARK", date: "5/26/2026", ent: "41", advisory: "No" })}
      ${row({ location: "RED REEF PARK", date: "5/26/2026", ent: "80", advisory: "Yes" })}
      ${row({ location: "BOYNTON BEACH", date: "5/26/2026", ent: "10", advisory: "No" })}
      ${row({ location: "DUBOIS PARK", date: "5/26/2026", ent: "NR", advisory: "No" })}
    </tbody>
  </table>
  <span class="cbResultSetNavigationMessages">Records 1-10 of 50</span>
</body></html>`;

describe("rateEnterococci", () => {
  it("maps CFU/100ml to good / moderate / poor at the program thresholds", () => {
    expect(rateEnterococci(0)).toBe("good");
    expect(rateEnterococci(35)).toBe("good");
    expect(rateEnterococci(36)).toBe("moderate");
    expect(rateEnterococci(70)).toBe("moderate");
    expect(rateEnterococci(71)).toBe("poor");
    expect(rateEnterococci(384)).toBe("poor");
  });

  it("treats invalid readings as unknown", () => {
    expect(rateEnterococci(NaN)).toBe("unknown");
    expect(rateEnterococci(-1)).toBe("unknown");
  });
});

describe("parseHealthyBeaches", () => {
  const rows = parseHealthyBeaches(PAGE);

  it("extracts location, date, enterococci and advisory per row", () => {
    const red = rows.find(
      (r) => r.location === "RED REEF PARK" && r.sampledLabel === "5/26/2026",
    );
    expect(red).toBeDefined();
    expect(red!.enterococci).toBe(80);
    expect(red!.advisory).toBe(true);
    expect(red!.sampledAt).toBe("2026-05-26T00:00:00.000Z");
  });

  it("does not confuse the map cell's 'Sample Date:' / 'Advisory: -1'", () => {
    const inlet = rows.find((r) => r.location === "SOUTH INLET PARK");
    expect(inlet!.sampledLabel).toBe("5/26/2026");
    expect(inlet!.advisory).toBe(false);
  });

  it("treats a non-numeric reading (NR) as no result", () => {
    const nr = rows.find((r) => r.location === "DUBOIS PARK");
    expect(nr!.enterococci).toBeUndefined();
  });
});

describe("parseTotalRecords", () => {
  it("reads the total count from the results footer", () => {
    expect(parseTotalRecords(PAGE)).toBe(50);
    expect(parseTotalRecords("<p>no records here</p>")).toBeNull();
  });
});

describe("summarizeWaterQuality", () => {
  const samples = parseHealthyBeaches(PAGE);
  const data = summarizeWaterQuality(samples, [
    "SPANISH RIVER",
    "SOUTH INLET PARK",
    "RED REEF PARK",
  ]);

  it("keeps only the most recent sample per configured site", () => {
    const spanish = data.sites.find((s) => /spanish/i.test(s.name));
    // 5/26 reading (10 -> good) wins over the older 5/18 reading (20).
    expect(spanish!.enterococci).toBe(10);
    expect(spanish!.rating).toBe("good");
  });

  it("rolls up to the worst site rating and flags any advisory", () => {
    expect(data.overall).toBe("poor"); // Red Reef Park = 80
    expect(data.advisory).toBe(true);
  });

  it("ignores sites that aren't configured for the town", () => {
    expect(data.sites.some((s) => /boynton/i.test(s.name))).toBe(false);
    expect(data.sites).toHaveLength(3);
  });

  it("reports unknown for a configured site with no matching sample", () => {
    const d = summarizeWaterQuality(samples, ["NONEXISTENT BEACH"]);
    expect(d.overall).toBe("unknown");
    expect(d.advisory).toBe(false);
    expect(d.sites[0].rating).toBe("unknown");
  });
});
