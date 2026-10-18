import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  OFFSET_MAX_AGE_MS,
  SERVER_NOW_TIMING,
  _resetServerClockForTests,
  learnFromResponse,
  learnOffset,
  offsetFromDateHeader,
  parseStoredOffset,
  serverNow,
  serverNowFromTiming,
} from "@/lib/serverClock";
import { SERVER_NOW_TIMING as EDGE_NAME } from "@/lib/edgeCache";
import { MOUNT_REVALIDATE_AFTER_MS, shouldRevalidateOnMount } from "@/lib/conditionsFreshness";

const SERVER = Date.parse("2026-10-18T12:00:00.000Z");

afterEach(() => {
  _resetServerClockForTests();
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

describe("server time from the page's Server-Timing", () => {
  it("reads ibd-now, the same name the edge cache writes", () => {
    expect(EDGE_NAME).toBe(SERVER_NOW_TIMING);
    expect(serverNowFromTiming([{ name: "ibd-now", description: String(SERVER) }])).toBe(SERVER);
  });
  it("ignores it on the service worker's saved copy (ibd-sw), where it is as old as the copy", () => {
    expect(serverNowFromTiming([{ name: "ibd-now", description: String(SERVER) }, { name: "ibd-sw", description: "1" }])).toBeNull();
    expect(serverNowFromTiming([])).toBeNull();
    expect(serverNowFromTiming([{ name: "ibd-now", description: "x" }])).toBeNull();
  });
});

describe("offset from a Date header", () => {
  it("is server minus device, from the middle of the header's second", () => {
    const date = new Date(SERVER).toUTCString();
    expect(offsetFromDateHeader(date, SERVER - 5 * 60_000)).toBe(5 * 60_000 + 500);
    expect(offsetFromDateHeader(null, SERVER)).toBeNull();
    expect(offsetFromDateHeader("garbage", SERVER)).toBeNull();
  });
  it("is not learned from the worker's saved copy", () => {
    learnFromResponse({ headers: new Headers({ date: new Date(SERVER).toUTCString(), "x-ibd-cached-at": "1" }) }, SERVER - 600_000);
    expect(serverNow(SERVER)).toBe(SERVER); // nothing learned: the device clock
  });
});

describe("a phone whose clock is off still refreshes old data", () => {
  it("clock 5 min slow, data 7 min old: the device clock says 2 min (no refresh), the server clock says 7", () => {
    const generatedAt = new Date(SERVER - 7 * 60_000).toISOString();
    const device = SERVER - 5 * 60_000;
    expect(shouldRevalidateOnMount(generatedAt, device)).toBe(false); // the old bug
    learnFromResponse({ headers: new Headers({ date: new Date(SERVER).toUTCString() }) }, device);
    expect(Math.abs(serverNow(device) - SERVER)).toBeLessThanOrEqual(1000);
    expect(shouldRevalidateOnMount(generatedAt, serverNow(device))).toBe(true);
  });
  it("clock fast: fresh data is not taken for old", () => {
    const generatedAt = new Date(SERVER - 60_000).toISOString();
    const device = SERVER + 10 * 60_000;
    expect(shouldRevalidateOnMount(generatedAt, device)).toBe(true);
    learnOffset(SERVER - device, device);
    expect(shouldRevalidateOnMount(generatedAt, serverNow(device))).toBe(false);
    expect(MOUNT_REVALIDATE_AFTER_MS).toBe(3 * 60_000);
  });
});

describe("stored offset", () => {
  it("is kept for a week and then dropped", () => {
    expect(parseStoredOffset(JSON.stringify({ offset: 1234, at: SERVER }), SERVER + 1000)).toBe(1234);
    expect(parseStoredOffset(JSON.stringify({ offset: 1234, at: SERVER }), SERVER + OFFSET_MAX_AGE_MS + 1)).toBeNull();
    expect(parseStoredOffset("{bad", SERVER)).toBeNull();
    expect(parseStoredOffset(null, SERVER)).toBeNull();
  });
  it("learning writes it for the next page", () => {
    const store = new Map<string, string>();
    (globalThis as { localStorage?: unknown }).localStorage = { setItem: (k: string, v: string) => void store.set(k, v), getItem: (k: string) => store.get(k) ?? null };
    learnOffset(4321, SERVER);
    expect(parseStoredOffset(store.get("ibd:clock-offset") ?? null, SERVER)).toBe(4321);
  });
});

describe("the dashboard measures data age on the server's clock", () => {
  it("both freshness checks use serverNow() and every data answer teaches it", () => {
    const src = readFileSync(join(__dirname, "..", "components/ConditionsDashboard.tsx"), "utf8");
    expect(src).toMatch(/shouldRevalidateOnMount\(initial\.snapshot\.generatedAt, serverNow\(\)\)/);
    expect(src).toMatch(/shouldRefetchForFreshness\(latestGeneratedAtRef\.current, serverNow\(\), attempts\)/);
    expect(src.match(/learnFromResponse\(r\)/g)?.length).toBe(2);
  });
});
