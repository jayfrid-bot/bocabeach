import { describe, it, expect } from "vitest";
import { parseNdbcRealtime } from "@/lib/sources/buoy";

const SAMPLE = `#YY  MM DD hh mm WDIR WSPD GST  WVHT   DPD   APD MWD   PRES  ATMP  WTMP  DEWP  VIS PTDY  TIDE
#yr  mo dy hr mn degT m/s  m/s     m   sec   sec degT   hPa  degC  degC  degC  nmi  hPa   ft
2026 05 29 14 30 120  5.0  7.0    MM    MM    MM  MM 1015.0  27.0  28.0  22.0   MM   MM    MM
2026 05 29 14 00 130  4.5  6.0    MM    MM    MM  MM 1015.2  26.8  28.0  22.0   MM   MM    MM`;

describe("parseNdbcRealtime", () => {
  it("parses the most recent row and converts units", () => {
    const d = parseNdbcRealtime(SAMPLE);
    expect(d).not.toBeNull();
    expect(d!.windDirDeg).toBe(120);
    expect(d!.windSpeedMph).toBe(11); // 5.0 m/s
    expect(d!.windGustMph).toBe(16); // 7.0 m/s
    expect(d!.airTempF).toBe(81); // 27.0 C
    expect(d!.waterTempF).toBe(82); // 28.0 C
    expect(d!.observedAt).toBe("2026-05-29T14:30:00.000Z");
  });

  it("treats MM as missing", () => {
    const d = parseNdbcRealtime(SAMPLE);
    expect(d!.waveHeightFt).toBeUndefined();
    expect(d!.dominantPeriodS).toBeUndefined();
  });

  it("returns null when there are no data rows", () => {
    expect(parseNdbcRealtime("#header only\n#units")).toBeNull();
  });
});
