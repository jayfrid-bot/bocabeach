// Handler-level tests for the Plus API: /api/devices, /api/devices/trial,
// /api/devices/unlock, /api/presence. The handlers are called directly with a
// Request, so there is no server and no network; `getStore()` picks the
// in-memory backend because vitest sets VITEST.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { POST as devicesPost, GET as devicesGet } from "@/app/api/devices/route";
import { POST as trialPost } from "@/app/api/devices/trial/route";
import { POST as unlockPost } from "@/app/api/devices/unlock/route";
import { POST as presencePost, DELETE as presenceDelete } from "@/app/api/presence/route";
import { getStore } from "@/lib/db/store";
import { resetMemoryStore } from "@/lib/db/memoryStore";
import { MAX_ARM_MS } from "@/lib/db/plus";

const DEV = "11111111-2222-4333-8444-555555555555";
const HOUR = 3600 * 1000;

/** The app shell's User-Agent tag (capacitor.config appendUserAgent). The trial
 *  and unlock routes are app-only, so the default request here carries it. */
const APP_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) IsItBeachDayApp/ios";
const WEB_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Safari/605.1.15";

function post(url: string, body: unknown, ua: string = APP_UA): Request {
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": ua },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  resetMemoryStore();
});

async function json(res: Response): Promise<Record<string, never> & { ok?: boolean; error?: string; device?: Record<string, unknown> }> {
  return (await res.json()) as never;
}

describe("POST /api/devices", () => {
  it("creates a free device and echoes it back", async () => {
    const res = await devicesPost(post("https://x/api/devices", { deviceId: DEV, platform: "ios" }));
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.ok).toBe(true);
    expect(body.device).toMatchObject({ id: DEV, platform: "ios", plan: "free", trialUsed: false });
  });

  it("changes only the fields it is given", async () => {
    await devicesPost(post("https://x/api/devices", { deviceId: DEV, tz: "America/New_York" }));
    const res = await devicesPost(post("https://x/api/devices", { deviceId: DEV, homeSlug: "boca-raton" }));
    const body = await json(res);
    expect(body.device).toMatchObject({ tz: "America/New_York", homeSlug: "boca-raton" });
  });

  it("merges a partial prefs patch", async () => {
    await devicesPost(post("https://x/api/devices", { deviceId: DEV, prefs: { morning: false } }));
    const res = await devicesPost(post("https://x/api/devices", { deviceId: DEV, prefs: { rip: false } }));
    const prefs = (await json(res)).device?.prefs as Record<string, boolean>;
    expect(prefs.morning).toBe(false);
    expect(prefs.rip).toBe(false);
    expect(prefs.lightning).toBe(true);
  });

  it("stores a profile", async () => {
    const profile = { profiles: ["swim", "kids"], heat: "hot", crowds: "low" };
    const res = await devicesPost(post("https://x/api/devices", { deviceId: DEV, profile }));
    expect((await json(res)).device?.profile).toEqual(profile);
  });

  it("rejects a profile the scoring engine could not run", async () => {
    // A hand-made body used to be stored verbatim. `{profiles: "swim"}` threw
    // inside resolveScoring, and a nonsense ideal band scored every hour NaN —
    // the morning digest went out titled "Poor · NaN/100".
    for (const profile of [{ profiles: "swim" }, { profiles: [] }, { profiles: ["yachting"] }]) {
      const res = await devicesPost(post("https://x/api/devices", { deviceId: DEV, profile }));
      expect(res.status, JSON.stringify(profile)).toBe(400);
    }
  });

  it("stores a profile with the nonsense stripped out of it", async () => {
    const res = await devicesPost(
      post("https://x/api/devices", {
        deviceId: DEV,
        profile: {
          profiles: ["swim", "kids", "surf"],
          heat: "boiling",
          crowds: 7,
          advanced: { airIdeal: ["a", "b"], mult: { waves: 1e9, sky: 2 } },
        },
      }),
    );
    expect(res.status).toBe(200);
    expect((await json(res)).device?.profile).toEqual({
      profiles: ["swim", "kids"],
      heat: "normal",
      crowds: "normal",
      advanced: { mult: { sky: 2 } },
    });
  });

  it("rejects a missing or malformed deviceId", async () => {
    for (const deviceId of [undefined, "", "short", 42, "has space"]) {
      const res = await devicesPost(post("https://x/api/devices", { deviceId }));
      expect(res.status).toBe(400);
      expect((await json(res)).error).toBe("bad-request");
    }
  });

  it("rejects a timezone no clock can read", async () => {
    // The push run formats every device's local hour with Intl, which throws a
    // RangeError on a zone it does not know — and that killed the whole run.
    for (const tz of ["Mars/Olympus", "America/New York", "America/New_York; DROP"]) {
      const res = await devicesPost(post("https://x/api/devices", { deviceId: DEV, tz }));
      expect(res.status, tz).toBe(400);
    }
  });

  it("rejects an unknown beach, a bad platform and a non-boolean pref", async () => {
    for (const patch of [
      { homeSlug: "not-a-beach" },
      { platform: "windows-phone" },
      { prefs: { morning: "yes" } },
      { profile: [1, 2, 3] },
    ]) {
      const res = await devicesPost(post("https://x/api/devices", { deviceId: DEV, ...patch }));
      expect(res.status).toBe(400);
    }
  });

  it("rejects a body over 8 KB", async () => {
    const res = await devicesPost(
      post("https://x/api/devices", { deviceId: DEV, tz: "x", pad: "y".repeat(9000) }),
    );
    expect(res.status).toBe(400);
    expect((await json(res)).error).toBe("bad-request");
  });

  it("rejects unparseable JSON", async () => {
    const res = await devicesPost(
      new Request("https://x/api/devices", { method: "POST", body: "{oops" }),
    );
    expect(res.status).toBe(400);
  });
});

describe("GET /api/devices", () => {
  it("reads a device back", async () => {
    await devicesPost(post("https://x/api/devices", { deviceId: DEV, tz: "America/New_York" }));
    const res = await devicesGet(new Request(`https://x/api/devices?deviceId=${DEV}`));
    expect(res.status).toBe(200);
    expect((await json(res)).device).toMatchObject({ id: DEV, tz: "America/New_York" });
  });

  it("404s an unknown device and 400s a malformed id", async () => {
    const missing = await devicesGet(new Request(`https://x/api/devices?deviceId=${DEV}`));
    expect(missing.status).toBe(404);
    expect((await json(missing)).error).toBe("not-found");

    const bad = await devicesGet(new Request("https://x/api/devices?deviceId=nope"));
    expect(bad.status).toBe(400);
  });
});

describe("POST /api/devices/trial", () => {
  it("grants three days of Plus once", async () => {
    const before = Date.now();
    const res = await trialPost(post("https://x/api/devices/trial", { deviceId: DEV }));
    expect(res.status).toBe(200);
    const device = (await json(res)).device as { plan: string; entitlementUntil: number; trialUsed: boolean };
    expect(device.plan).toBe("plus");
    expect(device.trialUsed).toBe(true);
    expect(device.entitlementUntil).toBeGreaterThanOrEqual(before + 3 * 24 * HOUR);
  });

  it("refuses a second trial with 409", async () => {
    await trialPost(post("https://x/api/devices/trial", { deviceId: DEV }));
    const res = await trialPost(post("https://x/api/devices/trial", { deviceId: DEV }));
    expect(res.status).toBe(409);
    expect((await json(res)).error).toBe("trial-used");
  });

  it("refuses a second trial even after the first expired", async () => {
    await trialPost(post("https://x/api/devices/trial", { deviceId: DEV }));
    const store = await getStore();
    await store.upsertDevice(DEV, { plan: "free", entitlementUntil: null });
    const res = await trialPost(post("https://x/api/devices/trial", { deviceId: DEV }));
    expect(res.status).toBe(409);
  });
});

describe("POST /api/devices/unlock", () => {
  const OLD = process.env.PLUS_UNLOCK_CODE;
  afterEach(() => {
    if (OLD === undefined) delete process.env.PLUS_UNLOCK_CODE;
    else process.env.PLUS_UNLOCK_CODE = OLD;
  });

  it("grants a year for the right code", async () => {
    process.env.PLUS_UNLOCK_CODE = "sandy-shoes";
    const before = Date.now();
    const res = await unlockPost(post("https://x/api/devices/unlock", { deviceId: DEV, code: "sandy-shoes" }));
    expect(res.status).toBe(200);
    const device = (await json(res)).device as { plan: string; entitlementUntil: number };
    expect(device.plan).toBe("plus");
    expect(device.entitlementUntil).toBeGreaterThanOrEqual(before + 364 * 24 * HOUR);
  });

  it("rejects a wrong code with 403", async () => {
    process.env.PLUS_UNLOCK_CODE = "sandy-shoes";
    const res = await unlockPost(post("https://x/api/devices/unlock", { deviceId: DEV, code: "nope" }));
    expect(res.status).toBe(403);
    expect((await json(res)).error).toBe("bad-code");
  });

  it("rejects every code when none is configured", async () => {
    delete process.env.PLUS_UNLOCK_CODE;
    const res = await unlockPost(post("https://x/api/devices/unlock", { deviceId: DEV, code: "" }));
    expect(res.status).toBe(403);
  });
});

describe("/api/presence", () => {
  async function makePlus(): Promise<void> {
    const store = await getStore();
    await store.upsertDevice(DEV, { plan: "plus", entitlementUntil: Date.now() + 30 * 24 * HOUR });
  }

  const fix = {
    slug: "boca-raton",
    lat: 26.35,
    lon: -80.07,
    accuracyM: 15,
    fixAt: Date.now(),
    source: "auto",
  };

  it("refuses a free device with 403", async () => {
    const store = await getStore();
    await store.upsertDevice(DEV, {});
    const res = await presencePost(
      post("https://x/api/presence", { deviceId: DEV, ...fix, armedUntil: Date.now() + HOUR }),
    );
    expect(res.status).toBe(403);
    expect((await json(res)).error).toBe("not-entitled");
  });

  it("refuses an unknown device with 403", async () => {
    const res = await presencePost(
      post("https://x/api/presence", { deviceId: DEV, ...fix, armedUntil: Date.now() + HOUR }),
    );
    expect(res.status).toBe(403);
  });

  it("arms a Plus device", async () => {
    await makePlus();
    const armedUntil = Date.now() + 4 * HOUR;
    const res = await presencePost(post("https://x/api/presence", { deviceId: DEV, ...fix, armedUntil }));
    expect(res.status).toBe(200);
    expect((await json(res)).device?.presence).toEqual({
      slug: "boca-raton",
      armedUntil,
      source: "auto",
    });
  });

  it("clamps a window longer than eight hours", async () => {
    await makePlus();
    const now = Date.now();
    const res = await presencePost(
      post("https://x/api/presence", { deviceId: DEV, ...fix, armedUntil: now + 48 * HOUR }),
    );
    const presence = (await json(res)).device?.presence as { armedUntil: number };
    expect(presence.armedUntil).toBeLessThanOrEqual(now + MAX_ARM_MS + 50);
    expect(presence.armedUntil).toBeGreaterThan(now + MAX_ARM_MS - 5000);
  });

  it("rejects an unknown beach and a bad source", async () => {
    await makePlus();
    const bad = await presencePost(
      post("https://x/api/presence", { deviceId: DEV, ...fix, slug: "atlantis", armedUntil: Date.now() }),
    );
    expect(bad.status).toBe(400);

    const src = await presencePost(
      post("https://x/api/presence", { deviceId: DEV, ...fix, source: "guess", armedUntil: Date.now() }),
    );
    expect(src.status).toBe(400);
  });

  it("rejects an out-of-range fix", async () => {
    await makePlus();
    const res = await presencePost(
      post("https://x/api/presence", { deviceId: DEV, ...fix, lat: 999, armedUntil: Date.now() }),
    );
    expect(res.status).toBe(400);
  });

  it("disarms", async () => {
    await makePlus();
    await presencePost(post("https://x/api/presence", { deviceId: DEV, ...fix, armedUntil: Date.now() + HOUR }));
    const res = await presenceDelete(
      new Request("https://x/api/presence", { method: "DELETE", body: JSON.stringify({ deviceId: DEV }) }),
    );
    expect(res.status).toBe(200);
    expect((await json(res)).device?.presence).toBeNull();

    const store = await getStore();
    expect(await store.listArmed(Date.now())).toHaveLength(0);
  });

  it("disarms via the query string too", async () => {
    await makePlus();
    await presencePost(post("https://x/api/presence", { deviceId: DEV, ...fix, armedUntil: Date.now() + HOUR }));
    const res = await presenceDelete(
      new Request(`https://x/api/presence?deviceId=${DEV}`, { method: "DELETE" }),
    );
    expect(res.status).toBe(200);
  });
});

// Plus is sold and delivered only inside the phone app. The website shows what
// Plus is and points to the App Store; it must never be able to start a trial or
// redeem a code, whatever its client-side `platform` field claims.
describe("Plus purchase routes are app-only", () => {
  it("trial from a browser User-Agent is refused with 403 app-only", async () => {
    const res = await trialPost(post("https://x/api/devices/trial", { deviceId: DEV }, WEB_UA));
    expect(res.status).toBe(403);
    expect((await json(res)).error).toBe("app-only");
    // And nothing was granted.
    const store = await getStore();
    expect((await store.getDevice(DEV))?.plan ?? "free").toBe("free");
  });

  it("unlock from a browser User-Agent is refused before the code is even checked", async () => {
    process.env.PLUS_UNLOCK_CODE = "sandy-shoes";
    const res = await unlockPost(
      post("https://x/api/devices/unlock", { deviceId: DEV, code: "sandy-shoes" }, WEB_UA),
    );
    expect(res.status).toBe(403);
    expect((await json(res)).error).toBe("app-only");
  });

  it("the same requests from the app shell succeed", async () => {
    const res = await trialPost(post("https://x/api/devices/trial", { deviceId: DEV }));
    expect(res.status).toBe(200);
  });
});
