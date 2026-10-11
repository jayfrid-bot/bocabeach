// GET /api/cam-frames/img — signed delivery of one archived frame.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sign } from "@/lib/camFrames/sign";
import { fakeBucket, fakeJpeg, type FakeBucket } from "@/lib/camFrames/testFixtures";

const ctl = vi.hoisted(() => ({ bucket: null as unknown, disabled: new Set<string>() }));
vi.mock("@/lib/camFrames/r2", () => ({ getCamFramesBucket: async () => ctl.bucket }));
vi.mock("@/lib/camFrames/manifest", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/camFrames/manifest")>();
  return {
    ...real,
    lookupCam: (slug: string, cam: string) =>
      ctl.disabled.has(cam) ? { status: "disabled" as const } : real.lookupCam(slug, cam),
  };
});

import { GET } from "@/app/api/cam-frames/img/route";

const KEY = "unit-test-signing-key-not-a-secret";
const K = "boca-raton/boca-south/2026-10-11/1405Z-01234567-cccccccc.jpg";
const NOW = Date.parse("2026-10-11T14:20:00.000Z");
const NOW_SEC = Math.floor(NOW / 1000);

let bucket: FakeBucket;

async function signedUrl(k: string = K, ttl = 900): Promise<URL> {
  const { exp, sig } = await sign(k, ttl, { nowSec: NOW_SEC, key: KEY });
  return new URL(`http://localhost/api/cam-frames/img?k=${encodeURIComponent(k)}&exp=${exp}&sig=${sig}`);
}

function get(url: URL): Promise<Response> {
  return GET(new Request(url));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  process.env.CAM_FRAME_URL_KEY = KEY;
  ctl.disabled = new Set();
  bucket = fakeBucket();
  ctl.bucket = bucket;
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.CAM_FRAME_URL_KEY;
});

describe("a good link", () => {
  it("streams the JPEG with the privacy headers and the seconds left on the link", async () => {
    const bytes = fakeJpeg(20_000, 3);
    bucket.objects.set(K, { bytes });
    const res = await get(await signedUrl());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(res.headers.get("cache-control")).toBe("private, max-age=900");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
  });

  it("counts the cache lifetime down as the link ages", async () => {
    bucket.objects.set(K, { bytes: fakeJpeg() });
    const url = await signedUrl();
    vi.setSystemTime(NOW + 600_000);
    const res = await get(url);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, max-age=300");
  });
});

describe("403 on a bad link", () => {
  beforeEach(() => bucket.objects.set(K, { bytes: fakeJpeg() }));

  it("a tampered signature, key or expiry", async () => {
    const url = await signedUrl();
    const badSig = new URL(url);
    badSig.searchParams.set("sig", "A".repeat(43));
    expect((await get(badSig)).status).toBe(403);

    const otherKey = new URL(url);
    otherKey.searchParams.set("k", K.replace("1405Z", "1406Z"));
    expect((await get(otherKey)).status).toBe(403);

    const longer = new URL(url);
    longer.searchParams.set("exp", String(Number(url.searchParams.get("exp")) + 1));
    expect((await get(longer)).status).toBe(403);
  });

  it("an expired link", async () => {
    const url = await signedUrl();
    vi.setSystemTime(NOW + 901_000);
    expect((await get(url)).status).toBe(403);
  });

  it("a far-future expiry, even correctly signed", async () => {
    const { exp, sig } = await sign(K, 1200, { nowSec: NOW_SEC + 600, key: KEY }); // exp = now + 1800
    const url = new URL(`http://localhost/api/cam-frames/img?k=${encodeURIComponent(K)}&exp=${exp}&sig=${sig}`);
    expect((await get(url)).status).toBe(403);
  });

  it("missing parameters, a malformed key, or a link signed with another secret", async () => {
    expect((await get(new URL("http://localhost/api/cam-frames/img"))).status).toBe(403);
    const url = await signedUrl();
    for (const p of ["k", "exp", "sig"]) {
      const u = new URL(url);
      u.searchParams.delete(p);
      expect((await get(u)).status).toBe(403);
    }
    const traversal = new URL(url);
    traversal.searchParams.set("k", "../../etc/passwd");
    expect((await get(traversal)).status).toBe(403);
    process.env.CAM_FRAME_URL_KEY = "a-different-secret";
    expect((await get(url)).status).toBe(403);
  });

  it("every link when no signing key is configured", async () => {
    const url = await signedUrl();
    delete process.env.CAM_FRAME_URL_KEY;
    expect((await get(url)).status).toBe(403);
  });
});

describe("the cam in the key", () => {
  it("403 once the cam is set to archive: false, even with a valid link", async () => {
    bucket.objects.set(K, { bytes: fakeJpeg() });
    const url = await signedUrl();
    ctl.disabled.add("boca-south");
    const res = await get(url);
    expect(res.status).toBe(403);
    expect(res.headers.get("content-type")).not.toBe("image/jpeg");
  });

  it("404 for a cam that is not in the config at all", async () => {
    const k = "boca-raton/no-such-cam/2026-10-11/1405Z-01234567-cccccccc.jpg";
    bucket.objects.set(k, { bytes: fakeJpeg() });
    expect((await get(await signedUrl(k))).status).toBe(404);
  });
});

describe("storage", () => {
  it("404 when the object is gone", async () => {
    expect((await get(await signedUrl())).status).toBe(404);
  });

  it("503 when the R2 binding is absent", async () => {
    ctl.bucket = null;
    expect((await get(await signedUrl())).status).toBe(503);
  });

  it("503 when R2 throws", async () => {
    bucket.get = async () => {
      throw new Error("r2 down");
    };
    expect((await get(await signedUrl())).status).toBe(503);
  });
});
