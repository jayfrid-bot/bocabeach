// Handler-level tests for POST /api/hazards. The route is called directly
// with a Request, so there is no server and no network — the lightning feed,
// fetchPrecipRadar, and rainForFix are all mocked so the test drives exactly
// what assessLightning/assessRain see. getConditions is deliberately NOT
// mocked or imported — the route must never call it (Codex review #2: it's
// the whole ~25-fetch conditions pipeline, which alone can exceed the Free
// plan's 50-subrequest cap on a cold call).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resetMemoryRateLimit } from "@/lib/plus/rateLimit";
import { getStore, hashInstallToken } from "@/lib/db/store";
import { resetMemoryStore } from "@/lib/db/memoryStore";
import type { LightningFeed } from "@/lib/sources/lightning";
import type { PrecipRadarData, Wrapped } from "@/lib/types";

const APP_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) IsItBeachDayApp/ios";
const WEB_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Safari/605.1.15";
const DEV = "11111111-2222-4333-8444-555555555555";
/** This device's install token (Codex review #1) for every test below —
 *  minted directly via the store so these tests don't need a real
 *  POST /api/devices round trip just to get one. */
const INSTALL_TOKEN = "install-token-for-hazards-tests";

// Boca Raton: 26.3587,-80.0686. This is ~0.5 mi away — near the beach.
const NEAR_LAT = 26.365;
const NEAR_LON = -80.0686;
// ~120 mi away — well past the 15 km "too-far" gate.
const FAR_LAT = 28.5;
const FAR_LON = -80.0686;

let mockFeed: LightningFeed | null;
let mockRadar: Wrapped<PrecipRadarData> | null;
let mockRain: unknown;

vi.mock("@/lib/alerts/lightningFeed", () => ({
  loadLightningFeed: async () => mockFeed,
}));
vi.mock("@/lib/sources/precipRadar", async () => {
  const actual = await vi.importActual<typeof import("@/lib/sources/precipRadar")>("@/lib/sources/precipRadar");
  return { ...actual, fetchPrecipRadar: async () => mockRadar };
});
vi.mock("@/lib/alerts/rain", async () => {
  const actual = await vi.importActual<typeof import("@/lib/alerts/rain")>("@/lib/alerts/rain");
  return { ...actual, rainForFix: async () => mockRain };
});

function post(
  body: Record<string, unknown>,
  opts: { ua?: string; ip?: string; installToken?: string | null } = {},
): Request {
  const { ua = APP_UA, ip = "1.2.3.4", installToken = INSTALL_TOKEN } = opts;
  return new Request("https://x/api/hazards", {
    method: "POST",
    headers: {
      "User-Agent": ua,
      "cf-connecting-ip": ip,
      "content-type": "application/json",
      ...(installToken ? { "x-install-token": installToken } : {}),
    },
    body: JSON.stringify(body),
  });
}

const BASE_BODY = {
  deviceId: DEV,
  lat: NEAR_LAT,
  lon: NEAR_LON,
  slug: "boca-raton",
  accuracyM: 30,
  fixAt: Date.now(),
};

beforeEach(async () => {
  resetMemoryRateLimit();
  resetMemoryStore();
  mockFeed = null;
  mockRadar = { source: "x", status: "best-effort", fetchedAt: new Date().toISOString(), attribution: "x", data: null };
  mockRain = null;
  // Codex review #1: /api/hazards requires the install token once a device
  // has one on file — mint it directly rather than round-tripping through
  // POST /api/devices in every test.
  const store = await getStore();
  await store.upsertDevice(DEV, {}); // the row `setInstallTokenHash` requires to already exist
  await store.setInstallTokenHash(DEV, hashInstallToken(INSTALL_TOKEN), Date.now());
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/hazards", () => {
  it("403s a non-native request", async () => {
    const { POST } = await import("@/app/api/hazards/route");
    const res = await POST(post(BASE_BODY, { ua: WEB_UA }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("app-only");
  });

  // --- Install token identity (Codex review #1) -----------------------------
  it("401 token-required for a device with no install token on file", async () => {
    const { POST } = await import("@/app/api/hazards/route");
    const NEW_DEV = "22222222-2222-4333-8444-555555555555";
    const res = await POST(post({ ...BASE_BODY, deviceId: NEW_DEV }));
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("token-required");
  });

  it("401 no-token when the header is missing or wrong for a device that has a token", async () => {
    const { POST } = await import("@/app/api/hazards/route");
    const missing = await POST(post(BASE_BODY, { installToken: null }));
    expect(missing.status).toBe(401);
    expect((await missing.json()).error).toBe("no-token");
    const wrong = await POST(post(BASE_BODY, { installToken: "nope" }));
    expect(wrong.status).toBe(401);
    expect((await wrong.json()).error).toBe("no-token");
  });

  it("400s a missing/malformed deviceId", async () => {
    const { POST } = await import("@/app/api/hazards/route");
    const res = await POST(post({ ...BASE_BODY, deviceId: "short" }));
    expect(res.status).toBe(400);
  });

  it("400s a non-finite or out-of-bbox lat/lon", async () => {
    const { POST } = await import("@/app/api/hazards/route");
    for (const bad of [{ lat: Number.NaN, lon: NEAR_LON }, { lat: 5, lon: 5 }]) {
      const res = await POST(post({ ...BASE_BODY, ...bad }));
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
  });

  it("400s a malformed accuracyM/fixAt", async () => {
    const { POST } = await import("@/app/api/hazards/route");
    const res = await POST(post({ ...BASE_BODY, accuracyM: "far" }));
    expect(res.status).toBe(400);
  });

  it("400s inaccurate-fix when accuracyM is missing", async () => {
    const { POST } = await import("@/app/api/hazards/route");
    const { accuracyM: _drop, ...rest } = BASE_BODY;
    const res = await POST(post(rest));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("inaccurate-fix");
  });

  it("400s inaccurate-fix when accuracyM exceeds the 500m gate", async () => {
    const { POST } = await import("@/app/api/hazards/route");
    const res = await POST(post({ ...BASE_BODY, accuracyM: 501 }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("inaccurate-fix");
  });

  it("400s stale-fix when fixAt is missing", async () => {
    const { POST } = await import("@/app/api/hazards/route");
    const { fixAt: _drop, ...rest } = BASE_BODY;
    const res = await POST(post(rest));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("stale-fix");
  });

  it("400s stale-fix when the fix is older than the 3-minute arrival window", async () => {
    const { POST } = await import("@/app/api/hazards/route");
    const res = await POST(post({ ...BASE_BODY, fixAt: Date.now() - 4 * 60 * 1000 }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("stale-fix");
  });

  it("400s future-fix when the fix is dated more than 60s ahead", async () => {
    const { POST } = await import("@/app/api/hazards/route");
    const res = await POST(post({ ...BASE_BODY, fixAt: Date.now() + 2 * 60 * 1000 }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("future-fix");
  });

  it("400s too-far when the fix is outside the 2-mile arrival radius, even if inside 15 km", async () => {
    const { POST } = await import("@/app/api/hazards/route");
    // ~3 mi north of Spanish River Park — the northern end of Boca's shore
    // stretch (config/locations.ts) — so still outside the 2 mi gate even
    // though it measures to the closest point on the shore, not the pin.
    // (A smaller +0.045 offset used to clear this gate before Boca's shore
    // was added: it's ~1.9 mi from Spanish River Park, inside 2 mi now that
    // "too-far" is measured to the beach's shoreline rather than its pin —
    // see lib/location/shoreDistance.ts.)
    const res = await POST(post({ ...BASE_BODY, lat: NEAR_LAT + 0.06, lon: NEAR_LON }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("too-far");
  });

  it("accepts a fix within 2mi of Spanish River Park even though it's >2mi from Boca's pin (Codex fix)", async () => {
    // Same offset the too-far test used to clear the gate before Boca's
    // shore existed: ~1.9 mi from Spanish River Park (the shore's north
    // end), ~3.1 mi from Boca's own pin. The server gate must accept this —
    // the same shoreline rule the client's establishesArrival uses to arm.
    const { POST } = await import("@/app/api/hazards/route");
    const res = await POST(post({ ...BASE_BODY, lat: NEAR_LAT + 0.045, lon: NEAR_LON }));
    expect(res.status).toBe(200);
  });

  it("400s an unknown beach slug", async () => {
    const { POST } = await import("@/app/api/hazards/route");
    const res = await POST(post({ ...BASE_BODY, slug: "not-a-beach" }));
    expect(res.status).toBe(400);
  });

  it("400s a malformed JSON body", async () => {
    const { POST } = await import("@/app/api/hazards/route");
    const req = new Request("https://x/api/hazards", {
      method: "POST",
      headers: { "User-Agent": APP_UA, "cf-connecting-ip": "1.2.3.4", "content-type": "application/json" },
      body: "{not json",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("400s too-far when the fix is well outside the arrival radius of the beach", async () => {
    const { POST } = await import("@/app/api/hazards/route");
    const res = await POST(post({ ...BASE_BODY, lat: FAR_LAT, lon: FAR_LON }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("too-far");
  });

  it("429s after the device rate limit (30/hour) is exceeded", async () => {
    const { POST } = await import("@/app/api/hazards/route");
    let last: Response | null = null;
    for (let i = 0; i < 31; i++) {
      last = await POST(post(BASE_BODY));
    }
    expect(last!.status).toBe(429);
    expect(last!.headers.get("Retry-After")).toBeTruthy();
  });

  it("429s after the per-IP rate limit (300/hour) is exceeded, well past the per-device cap", async () => {
    const { POST } = await import("@/app/api/hazards/route");
    let last: Response | null = null;
    // Different deviceIds so only the per-IP counter is exercised.
    for (let i = 0; i < 301; i++) {
      const dev = `${String(i).padStart(8, "0")}-2222-4333-8444-555555555555`;
      last = await POST(post({ ...BASE_BODY, deviceId: dev }));
    }
    expect(last!.status).toBe(429);
  });

  it("happy path: point lightning active, beach not — anchors, lightningMi and cache-control are right", async () => {
    mockFeed = {
      generatedAt: "2026-09-02T17:58:00Z",
      windowMinutes: 30,
      // ~4.9 mi north of NEAR_LAT/NEAR_LON (inside the point's 5 mi hold) but
      // ~5.3 mi from Boca's centroid (26.3587,-80.0686) — outside the beach's.
      strikes: [[Math.floor(Date.now() / 1000) - 300, 26.436, -80.0686]],
    };
    const { POST } = await import("@/app/api/hazards/route");
    const res = await POST(post(BASE_BODY));
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    const body = (await res.json()) as {
      anchor: { kind: string; lat: number; lon: number; cell: string };
      lightning: { active: boolean };
      lightningMi: number | null;
      rain: { active: boolean };
      beach: { slug: string; lightning: { active: boolean }; lightningMi: number | null; rain: { active: boolean } };
      fetchedAt: string;
    };
    expect(body.anchor.kind).toBe("point");
    expect(body.anchor.lat).toBe(NEAR_LAT);
    expect(body.lightning.active).toBe(true);
    expect(body.lightningMi).toBeGreaterThan(4);
    expect(body.lightningMi).toBeLessThan(5);
    expect(body.beach.slug).toBe("boca-raton");
    expect(body.beach.lightning.active).toBe(false);
    expect(body.beach.lightningMi === null || body.beach.lightningMi! > 1).toBe(true);
  });

  it("never calls getConditions (route must not import it)", async () => {
    const routeSrc = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("./route.ts", import.meta.url), "utf8"),
    );
    expect(routeSrc.includes('from "@/lib/conditions"')).toBe(false);
  });

  it("never logs coordinates", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { POST } = await import("@/app/api/hazards/route");
    await POST(post(BASE_BODY));
    const allCalls = [...spy.mock.calls, ...errSpy.mock.calls].flat().map(String);
    expect(allCalls.some((s) => s.includes(String(NEAR_LAT)))).toBe(false);
    spy.mockRestore();
    errSpy.mockRestore();
  });
});
