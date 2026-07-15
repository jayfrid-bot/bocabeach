import { describe, expect, it } from "vitest";
import { uvBand, uvBandColor, uvBurnMinutes, uvBurnUrgency } from "@/lib/uv";

describe("uvBand", () => {
  it("maps the standard EPA cutoffs", () => {
    expect(uvBand(0)).toBe("Low");
    expect(uvBand(2)).toBe("Low");
    expect(uvBand(3)).toBe("Moderate");
    expect(uvBand(5)).toBe("Moderate");
    expect(uvBand(6)).toBe("High");
    expect(uvBand(7)).toBe("High");
    expect(uvBand(8)).toBe("Very High");
    expect(uvBand(10)).toBe("Very High");
    expect(uvBand(11)).toBe("Extreme");
    expect(uvBand(14)).toBe("Extreme");
  });
});

describe("uvBandColor", () => {
  it("returns a distinct color per band", () => {
    const colors = new Set([1, 4, 6, 9, 12].map(uvBandColor));
    expect(colors.size).toBe(5);
  });
});

describe("uvBurnMinutes", () => {
  it("is undefined below UV 1", () => {
    expect(uvBurnMinutes(0)).toBeUndefined();
    expect(uvBurnMinutes(0.5)).toBeUndefined();
  });

  it("matches the 200/uv rule the dashboard used inline", () => {
    expect(uvBurnMinutes(1)).toBe(200);
    expect(uvBurnMinutes(4)).toBe(50);
    expect(uvBurnMinutes(10)).toBe(20);
  });
});

describe("uvBurnUrgency", () => {
  it("is 0 when there is no burn estimate", () => {
    expect(uvBurnUrgency(undefined)).toBe(0);
  });

  it("is near 0 for a very long burn time and 1 for a very short one", () => {
    expect(uvBurnUrgency(200)).toBe(0);
    expect(uvBurnUrgency(14)).toBe(1);
  });

  it("decreases monotonically as burn time increases", () => {
    const short = uvBurnUrgency(20);
    const long = uvBurnUrgency(100);
    expect(short).toBeGreaterThan(long);
  });
});
