// Handler-level tests for POST /api/sun-observations: auth, strict validation,
// storage, and the write-back onto sun_event_predictions. The store is the real
// in-memory backend vitest always gets (lib/db/store.ts `getStore`).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { POST } from "@/app/api/sun-observations/route";
import { getStore } from "@/lib/db/store";
import { resetMemoryStore } from "@/lib/db/memoryStore";
import {
  ELBO_SUNRISE_ISO,
  NOW_AFTER_OCT6_SUNRISE,
  eventIso,
  predictionRow,
  sunObservationBody,
} from "@/lib/sunObservations.fixtures";

const TOKEN = "test-ingest-token";

function post(body: unknown, headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` }): Promise<Response> {
  return POST(
    new Request("http://localhost/api/sun-observations", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

beforeEach(() => {
  resetMemoryStore();
  process.env.INGEST_TOKEN = TOKEN;
  // Freeze only Date: the route refuses events in the future and ones over two years old.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW_AFTER_OCT6_SUNRISE));
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.INGEST_TOKEN;
});

describe("auth", () => {
  it("503s when INGEST_TOKEN is unset", async () => {
    delete process.env.INGEST_TOKEN;
    const res = await post(sunObservationBody());
    expect(res.status).toBe(503);
  });

  it("401s with no token, a wrong token, an empty bearer, or a bare token", async () => {
    for (const headers of [
      {},
      { authorization: "Bearer wrong-token" },
      { authorization: "Bearer " },
      { authorization: "Bearer" },
      { authorization: TOKEN }, // the courier path accepts a bare value; this route wants "Bearer "
    ] as Record<string, string>[]) {
      const res = await post(sunObservationBody(), headers);
      expect(res.status).toBe(401);
    }
    const store = await getStore();
    expect(await store.sunEventObservationsFor("fort-lauderdale", "sunrise", "2026-10-06")).toEqual([]);
  });

  it("checks auth before it reads the body", async () => {
    expect((await post("not json at all", {})).status).toBe(401);
  });

  it("never caches", async () => {
    const res = await post(sunObservationBody());
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});

describe("body validation", () => {
  it("400s on non-JSON, an empty body, a JSON array, and an oversize body", async () => {
    expect((await post("{nope")).status).toBe(400);
    expect((await post("")).status).toBe(400);
    expect((await post([1, 2])).status).toBe(400);
    const big = await post(sunObservationBody({}, { padding: "x".repeat(40_000) }));
    expect(big.status).toBe(400);
  });

  it("400s with the reason and stores nothing when a field is wrong", async () => {
    const res = await post(sunObservationBody({}, { credit: "Someone else" }));
    expect(res.status).toBe(400);
    const j = await json(res);
    expect(j.error).toBe("bad-request");
    expect(String(j.detail)).toMatch(/credit/);
    const store = await getStore();
    expect(await store.sunEventObservationsFor("fort-lauderdale", "sunrise", "2026-10-06")).toEqual([]);
  });

  it("400s an unknown field, a future event, and a score that is not the series' peak", async () => {
    expect((await post(sunObservationBody({}, { extra: true }))).status).toBe(400);
    expect((await post(sunObservationBody({ kind: "sunset" }))).status).toBe(400); // sunset is 23:01Z, "now" is 14:00Z
    expect((await post(sunObservationBody({}, { observed_score: 40 }))).status).toBe(400);
  });
});

describe("storing an observation", () => {
  it("200s, stores the row with the credit and the series, and reports the count", async () => {
    const res = await post(sunObservationBody());
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({
      ok: true,
      slug: "fort-lauderdale",
      event_kind: "sunrise",
      cam_id: "ftl-elbo-beach-cam",
      predictionsUpdated: 0,
    });
    const store = await getStore();
    const [row] = await store.sunEventObservationsFor("fort-lauderdale", "sunrise", "2026-10-06");
    expect(row).toMatchObject({
      cam_id: "ftl-elbo-beach-cam",
      view: "solar",
      distance_mi: 0,
      observed_score: 94.3,
      score_version: "2026-10-06.1",
      credit: "Live stream courtesy Elbo Room (ElboRoom.com)",
      event_iso: ELBO_SUNRISE_ISO,
      created_at: NOW_AFTER_OCT6_SUNRISE,
    });
    expect(JSON.parse(row.series_json)).toHaveLength(4);
  });

  it("a re-post of the same event and cam replaces the row (a re-score)", async () => {
    await post(sunObservationBody({ peak: 80 }, { score_version: "2026-10-06.1" }));
    await post(sunObservationBody({ peak: 94.3 }, { score_version: "2026-10-07.2" }));
    const store = await getStore();
    const rows = await store.sunEventObservationsFor("fort-lauderdale", "sunrise", "2026-10-06");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ observed_score: 94.3, score_version: "2026-10-07.2" });
  });
});

describe("filling the prediction rows", () => {
  const HOUR = (h: number) => `2026-10-06T${String(h).padStart(2, "0")}:00:00.000Z`;

  async function seed(): Promise<void> {
    const store = await getStore();
    await store.upsertSunEventPredictions([
      // the Fort Lauderdale sunrise, three archive hours, and one whose event time is 10 min off
      predictionRow({ slug: "fort-lauderdale", event_iso: ELBO_SUNRISE_ISO, as_of_hour_utc: HOUR(8), snapshot_generated_at: HOUR(8) }),
      predictionRow({ slug: "fort-lauderdale", event_iso: ELBO_SUNRISE_ISO, as_of_hour_utc: HOUR(9), snapshot_generated_at: HOUR(9) }),
      predictionRow({ slug: "fort-lauderdale", event_iso: "2026-10-06T11:25:00.000Z", as_of_hour_utc: HOUR(10), snapshot_generated_at: HOUR(10) }),
      // ...and rows that must NOT be touched: 20 min away, the sunset, another beach
      predictionRow({ slug: "fort-lauderdale", event_iso: "2026-10-06T11:36:00.000Z", as_of_hour_utc: HOUR(11), snapshot_generated_at: HOUR(11) }),
      predictionRow({ slug: "fort-lauderdale", event_kind: "sunset", event_iso: eventIso("fort-lauderdale", "sunset", "2026-10-06"), as_of_hour_utc: HOUR(12), snapshot_generated_at: HOUR(12) }),
      predictionRow({ slug: "boca-raton", as_of_hour_utc: HOUR(10), snapshot_generated_at: HOUR(10) }),
    ]);
  }

  async function observed(slug: string, kind: "sunrise" | "sunset", iso: string) {
    const store = await getStore();
    return store.sunEventPredictionsFor(slug, iso).then((rows) => rows.filter((r) => r.event_kind === kind));
  }

  it("writes observed_score / observed_source / observed_at on the same event's rows within 15 min", async () => {
    await seed();
    const res = await post(sunObservationBody());
    expect(await json(res)).toMatchObject({ ok: true, predictionsUpdated: 3 });

    for (const r of await observed("fort-lauderdale", "sunrise", ELBO_SUNRISE_ISO)) {
      expect(r.observed_score).toBe(94.3);
      expect(r.observed_source).toBe("sun-cam:ftl-elbo-beach-cam:solar");
      expect(r.observed_at).toBe(NOW_AFTER_OCT6_SUNRISE);
    }
    const tenOff = await observed("fort-lauderdale", "sunrise", "2026-10-06T11:25:00.000Z");
    expect(tenOff[0].observed_score).toBe(94.3);

    // the model's own columns are untouched
    expect((await observed("fort-lauderdale", "sunrise", ELBO_SUNRISE_ISO))[0]).toMatchObject({ score: 58, band: "good" });

    // outside the window, other kind, other beach: no truth written
    expect((await observed("fort-lauderdale", "sunrise", "2026-10-06T11:36:00.000Z"))[0].observed_score).toBeNull();
    const sunsetIso = eventIso("fort-lauderdale", "sunset", "2026-10-06");
    expect((await observed("fort-lauderdale", "sunset", sunsetIso))[0].observed_score).toBeNull();
    expect((await observed("boca-raton", "sunrise", "2026-10-06T11:15:09.672Z"))[0].observed_score).toBeNull();
  });

  it("with several cams, the closest one wins whatever order they arrive in", async () => {
    const store = await getStore();
    const iso = eventIso("deerfield-beach", "sunrise", "2026-10-06");
    await store.upsertSunEventPredictions([predictionRow({ slug: "deerfield-beach", event_iso: iso })]);
    const send = (camId: string, peak: number) => post(sunObservationBody({ slug: "deerfield-beach", camId, peak }));
    const source = async () => (await store.sunEventPredictionsFor("deerfield-beach", iso))[0];

    await send("deerfield-pier-cam", 70); // 0.1 mi
    expect(await source()).toMatchObject({ observed_score: 70, observed_source: "sun-cam:deerfield-pier-cam:solar" });
    await send("deerfield-surf-cam", 60); // 0.0 mi, closer
    expect(await source()).toMatchObject({ observed_score: 60, observed_source: "sun-cam:deerfield-surf-cam:solar" });
    await send("deerfield-beach-cam", 90); // 0.0 mi, ties the surf cam; cam_id breaks it
    expect(await source()).toMatchObject({ observed_score: 90, observed_source: "sun-cam:deerfield-beach-cam:solar" });
    await send("deerfield-pier-cam", 50); // a later, farther cam never displaces it
    expect(await source()).toMatchObject({ observed_score: 90, observed_source: "sun-cam:deerfield-beach-cam:solar" });
  });

  it("leaves a hand-labelled row alone, and replaces an earlier sun-cam label", async () => {
    const store = await getStore();
    await store.upsertSunEventPredictions([
      predictionRow({
        slug: "fort-lauderdale",
        event_iso: ELBO_SUNRISE_ISO,
        observed_score: 88,
        observed_source: "manual",
        observed_at: "2026-10-06T13:00:00.000Z",
      }),
    ]);
    const res = await post(sunObservationBody());
    expect(await json(res)).toMatchObject({ ok: true, predictionsUpdated: 0 });
    expect((await store.sunEventPredictionsFor("fort-lauderdale", ELBO_SUNRISE_ISO))[0]).toMatchObject({
      observed_score: 88,
      observed_source: "manual",
    });
    // the observation itself is still stored
    expect(await store.sunEventObservationsFor("fort-lauderdale", "sunrise", "2026-10-06")).toHaveLength(1);
  });
});
