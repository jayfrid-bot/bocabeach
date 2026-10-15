import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CARD_REFRESH_MINUTES,
  CARD_REFRESH_WORST_CASE_MINUTES,
  CARD_UPDATE_NOTE,
  classifyOwnerFailure,
  enrollGateText,
  enrollThisPhone,
  OWNER_TOKEN_KEY,
  ownerErrorText,
  ownerPost,
  ownerRequestInit,
  readOwnerHint,
  readOwnerToken,
  syncOwnerPushToken,
  takeEnrollCode,
  writeOwnerHint,
  writeOwnerToken,
} from "@/lib/quality/client";

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubStorage(): Map<string, string> {
  const m = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  });
  return m;
}

describe("ownerRequestInit", () => {
  it("is a JSON POST with the owner token as a Bearer header and nothing about a device in the body", () => {
    const init = ownerRequestInit("tok", { alertId: 4 });
    expect(init.method).toBe("POST");
    expect(init.cache).toBe("no-store");
    expect(init.headers).toEqual({ "content-type": "application/json", authorization: "Bearer tok" });
    expect(JSON.parse(init.body as string)).toEqual({ alertId: 4 });
  });

  it("omits the header when there is no token", () => {
    expect(ownerRequestInit(null, {}).headers).toEqual({ "content-type": "application/json" });
  });
});

describe("ownerPost", () => {
  it("sends this phone's token and returns the data", async () => {
    stubStorage().set(OWNER_TOKEN_KEY, "tok-1");
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, open: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const r = await ownerPost<{ ok: true; open: unknown[] }>("/api/quality/owner/list", { x: 1 });
    expect(r).toEqual({ ok: true, data: { ok: true, open: [] } });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/quality/owner/list");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer tok-1");
    expect(JSON.parse(init.body as string)).toEqual({ x: 1 });
  });

  it("makes no request at all for a phone that never enrolled", async () => {
    stubStorage();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await ownerPost("/p")).toEqual({ ok: false, error: "unauthorized", status: 401 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("turns a refusal into an error code and a network failure into 'network'", async () => {
    stubStorage().set(OWNER_TOKEN_KEY, "tok");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: false, error: "unauthorized" }), { status: 401 })));
    expect(await ownerPost("/p")).toEqual({ ok: false, error: "unauthorized", status: 401 });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>", { status: 502 })));
    expect(await ownerPost("/p")).toEqual({ ok: false, error: "server", status: 502 });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    expect(await ownerPost("/p")).toEqual({ ok: false, error: "network", status: 0 });
  });
});

describe("enrolling", () => {
  it("sends the code in the BODY, keeps the token it gets back, and never stores the code", async () => {
    const m = stubStorage();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, token: "owner-token-xyz" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const r = await enrollThisPhone("the-code", "dev-1");
    expect(r.ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/quality/owner/enroll");
    expect(url).not.toContain("the-code");
    expect(JSON.parse(init.body as string)).toEqual({ code: "the-code", deviceId: "dev-1" });
    expect(m.get(OWNER_TOKEN_KEY)).toBe("owner-token-xyz");
    expect(JSON.stringify([...m.entries()])).not.toContain("the-code");
  });

  it("keeps nothing when the code was refused", async () => {
    const m = stubStorage();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: false, error: "bad-code" }), { status: 403 })));
    expect(await enrollThisPhone("nope", "dev-1")).toEqual({ ok: false, error: "bad-code", status: 403 });
    expect(m.size).toBe(0);
  });
});

describe("classifyOwnerFailure", () => {
  it("only a 401 or 403 means 'not the owner'; a passing trouble keeps the owner signed in", () => {
    expect(classifyOwnerFailure(401)).toBe("unauthorized");
    expect(classifyOwnerFailure(403)).toBe("unauthorized");
    for (const status of [0, 400, 404, 429, 500, 502, 503, 504]) expect(classifyOwnerFailure(status), String(status)).toBe("error");
  });
});

describe("enrollGateText", () => {
  it("tells a stranger nothing about what the owner screens are", () => {
    expect(enrollGateText("too-many-attempts")).toMatch(/too many/i);
    expect(enrollGateText("network")).toMatch(/connection/i);
    for (const e of ["bad-code", "enrollment-closed", "unauthorized", "server", "anything"]) {
      expect(enrollGateText(e)).toBe("That did not work.");
    }
  });
});

describe("takeEnrollCode", () => {
  const take = (hash: string, search: string) => {
    const replaced: string[] = [];
    const code = takeEnrollCode({ hash, search, pathname: "/admin/review" }, { replaceState: (_s, _t, url) => void replaced.push(String(url)) });
    return { code, replaced };
  };

  it("reads the code from the fragment (never sent to a server) and removes it from the address bar", () => {
    expect(take("#enroll=abc123", "")).toEqual({ code: "abc123", replaced: ["/admin/review"] });
  });

  it("does NOT read ?enroll=: a query reaches the server and its logs, so it is ignored and left alone", () => {
    expect(take("", "?enroll=abc123&alert=7")).toEqual({ code: null, replaced: [] });
  });

  it("keeps other query parameters and fragment parameters when it removes the code", () => {
    expect(take("#enroll=abc123&x=1", "?alert=7")).toEqual({ code: "abc123", replaced: ["/admin/review?alert=7#x=1"] });
  });

  it("is null, and changes nothing, with no code", () => {
    expect(take("", "?alert=7")).toEqual({ code: null, replaced: [] });
    expect(take("#top", "")).toEqual({ code: null, replaced: [] });
  });
});

describe("syncOwnerPushToken", () => {
  it("posts this phone's APNs token to the owner route, and does nothing without one", async () => {
    stubStorage().set(OWNER_TOKEN_KEY, "tok");
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await syncOwnerPushToken(async () => null)).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await syncOwnerPushToken(async () => "ab".repeat(32))).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/quality/owner/push-token");
    expect(JSON.parse(init.body as string)).toEqual({ token: "ab".repeat(32), platform: "ios" });
  });
});

describe("the owner token and the hint in storage", () => {
  it("round-trip, and clear", () => {
    stubStorage();
    expect(readOwnerToken()).toBeNull();
    writeOwnerToken("t");
    expect(readOwnerToken()).toBe("t");
    writeOwnerToken(null);
    expect(readOwnerToken()).toBeNull();
    expect(readOwnerHint()).toBe(false);
    writeOwnerHint(true);
    expect(readOwnerHint()).toBe(true);
    writeOwnerHint(false);
    expect(readOwnerHint()).toBe(false);
  });

  it("read as empty when storage is blocked", () => {
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => { throw new Error("blocked"); } });
    expect(readOwnerToken()).toBeNull();
    expect(readOwnerHint()).toBe(false);
    expect(() => writeOwnerToken("x")).not.toThrow();
    expect(() => writeOwnerHint(true)).not.toThrow();
  });
});

describe("plain words", () => {
  it("ownerErrorText has words for each refusal, none of them the raw code", () => {
    for (const code of ["unauthorized", "enrollment-closed", "bad-code", "too-many-attempts", "network", "something-else"]) {
      const text = ownerErrorText(code);
      expect(text.length).toBeGreaterThan(10);
      expect(text).not.toContain(code);
      expect(text).not.toMatch(/\bAI\b/);
    }
  });

  it("the beach-card note's numbers are the ones in the code that holds the old card", () => {
    const route = readFileSync("app/api/conditions/[slug]/route.ts", "utf8");
    const dash = readFileSync("components/ConditionsDashboard.tsx", "utf8");
    expect(route).toContain("public, s-maxage=300, stale-while-revalidate=600");
    expect(dash).toContain("refreshInterval: preview ? 0 : 300_000");
    // if either changes, this note and its numbers must change with it
    expect(CARD_REFRESH_MINUTES).toBe(300 / 60);
    expect(CARD_REFRESH_WORST_CASE_MINUTES).toBe((300 + 600) / 60);
  });

  it("the beach-card note says the true wait", () => {
    expect(CARD_REFRESH_MINUTES).toBe(5); // components/ConditionsDashboard.tsx refreshInterval: 300_000
    expect(CARD_REFRESH_WORST_CASE_MINUTES).toBe(15); // app/api/conditions/[slug]/route.ts: s-maxage=300 + stale-while-revalidate=600
    expect(CARD_UPDATE_NOTE).toContain("within 5 minutes");
    expect(CARD_UPDATE_NOTE).toContain("up to 15");
  });
});
