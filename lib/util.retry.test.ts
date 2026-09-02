import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchJsonWithRetry } from "@/lib/util";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function textResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/plain" } });
}

describe("fetchJsonWithRetry", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("retries once after a 500, using cache: no-store and no `next` option", async () => {
    const calls: RequestInit[] = [];
    const fetchMock = vi
      .fn()
      .mockImplementationOnce((_url: string, init: RequestInit) => {
        calls.push(init);
        return Promise.resolve(textResponse("server error", 500));
      })
      .mockImplementationOnce((_url: string, init: RequestInit) => {
        calls.push(init);
        return Promise.resolve(jsonResponse({ ok: true }));
      });
    vi.stubGlobal("fetch", fetchMock);

    const { json } = await fetchJsonWithRetry<{ ok: boolean }>("https://example.com/api", {
      next: { revalidate: 3600 },
    });

    expect(json).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const retryInit = calls[1] as RequestInit & { next?: unknown };
    expect(retryInit.cache).toBe("no-store");
    expect(retryInit.next).toBeUndefined();
  });

  it("retries once after a non-JSON 200 body, then succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(textResponse("Unexpected error occurred while processing", 200))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    const { json } = await fetchJsonWithRetry<{ ok: boolean }>("https://example.com/api");
    expect(json).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("makes exactly one fetch when the first try returns JSON 200", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    const { json } = await fetchJsonWithRetry<{ ok: boolean }>("https://example.com/api");
    expect(json).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws with status and body head after two failures", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(textResponse("first failure body text goes here", 500))
      .mockResolvedValueOnce(textResponse("second failure body text goes here too", 502));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchJsonWithRetry("https://example.com/api")).rejects.toThrow(
      /502.*second failure body text goes here/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws immediately on a 404 without retrying", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(textResponse("not found", 404));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchJsonWithRetry("https://example.com/api")).rejects.toThrow(/404/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
