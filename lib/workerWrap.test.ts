import { describe, expect, it, vi } from "vitest";
import { bufferResponse, cleanVary, isBufferedPath, withBufferedAgentResponses } from "@/lib/workerWrap";

const NEXT_VARY = "rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch";

/** A response whose body is a real stream with no length, as OpenNext hands back. */
function streamed(parts: string[], init: ResponseInit = {}): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const p of parts) c.enqueue(enc.encode(p));
      c.close();
    },
  });
  return new Response(body, init);
}

const run = (inner: (req: Request) => Response | Promise<Response>, url: string, method = "GET") => {
  const fetch = vi.fn(async (req: Request, _env?: unknown, _ctx?: unknown) => inner(req));
  const wrapped = withBufferedAgentResponses({ fetch, extra: 7 });
  return { wrapped, fetch, call: () => wrapped.fetch(new Request(url, { method }), {}, {}) };
};

describe("which paths are buffered", () => {
  it("the agent surface only", () => {
    for (const p of ["/mcp", "/llms.txt", "/api/v1/beaches", "/api/v1/beaches/boca-raton/outlook", "/api/v1/openapi.json", "/api/watch/boca-raton"]) {
      expect(isBufferedPath(p), p).toBe(true);
    }
    for (const p of ["/", "/boca-raton", "/mcp/extra", "/mcpx", "/api/v1", "/api/conditions/boca-raton", "/api/push/run", "/_next/static/x.js", "/llms.txt.map", "/api/watchx/a"]) {
      expect(isBufferedPath(p), p).toBe(false);
    }
  });
});

describe("cleanVary", () => {
  it("removes Next's tokens and keeps the rest", () => {
    expect(cleanVary(NEXT_VARY)).toBeNull();
    expect(cleanVary(`${NEXT_VARY}, Origin`)).toBe("Origin");
    expect(cleanVary(`Origin, ${NEXT_VARY}`)).toBe("Origin");
    expect(cleanVary("Origin")).toBe("Origin");
    expect(cleanVary("RSC, Next-Router-State-Tree, Accept-Encoding")).toBe("Accept-Encoding");
    expect(cleanVary(`${NEXT_VARY}, next-url`)).toBeNull();
    expect(cleanVary(null)).toBeNull();
  });
});

describe("the wrapper on agent paths", () => {
  it("turns a streamed, chunked body into a complete one with the right byte Content-Length", async () => {
    const json = JSON.stringify({ ok: true, credit: "Score by Is It Beach Day — isitbeachday.com" });
    const half = Math.floor(json.length / 2);
    const { call, fetch } = run(
      () =>
        streamed([json.slice(0, half), json.slice(half)], {
          status: 200,
          statusText: "OK",
          headers: { "Content-Type": "application/json", "Cache-Control": "no-store", Vary: `${NEXT_VARY}, Origin`, "Transfer-Encoding": "chunked", "X-Keep": "1" },
        }),
      "https://isitbeachday.com/mcp",
      "POST",
    );
    const res = await call();
    expect(fetch).toHaveBeenCalledTimes(1);
    const text = await res.clone().text();
    expect(text).toBe(json);
    expect(res.headers.get("Content-Length")).toBe(String(new TextEncoder().encode(json).byteLength));
    expect(Number(res.headers.get("Content-Length"))).toBeGreaterThan(json.length); // bytes, not characters
    expect(res.headers.get("Transfer-Encoding")).toBeNull();
    expect(res.headers.get("Vary")).toBe("Origin");
    expect(res.status).toBe(200);
    expect(res.statusText).toBe("OK");
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("X-Keep")).toBe("1");
  });

  it("drops Vary entirely when only Next's tokens were in it", async () => {
    const { call } = run(() => streamed(["{}"], { headers: { Vary: NEXT_VARY } }), "https://isitbeachday.com/api/v1/beaches");
    const res = await call();
    expect(res.headers.get("Vary")).toBeNull();
    expect(res.headers.get("Content-Length")).toBe("2");
  });

  it("keeps the status and headers of errors, and of a 202 with Content-Length 0", async () => {
    const err = await run(() => streamed(['{"error":1}'], { status: 429, headers: { "Retry-After": "12", Vary: NEXT_VARY } }), "https://isitbeachday.com/mcp", "POST").call();
    expect(err.status).toBe(429);
    expect(err.headers.get("Retry-After")).toBe("12");
    expect(err.headers.get("Content-Length")).toBe("11");
    const accepted = await run(() => streamed([], { status: 202, headers: { "Transfer-Encoding": "chunked", Vary: NEXT_VARY } }), "https://isitbeachday.com/mcp", "POST").call();
    expect(accepted.status).toBe(202);
    expect(accepted.headers.get("Content-Length")).toBe("0");
    expect(accepted.headers.get("Transfer-Encoding")).toBeNull();
    expect((await accepted.arrayBuffer()).byteLength).toBe(0);
    const nullBody = await run(() => new Response(null, { status: 202 }), "https://isitbeachday.com/mcp", "POST").call();
    expect(nullBody.headers.get("Content-Length")).toBe("0");
  });

  it("sends no body and no Content-Length for 204 and 304", async () => {
    for (const status of [204, 304]) {
      const res = await run(() => new Response(null, { status, headers: { "Content-Length": "5", "Access-Control-Allow-Origin": "*" } }), "https://isitbeachday.com/api/v1/beaches", "OPTIONS").call();
      expect(res.status).toBe(status);
      expect(res.headers.get("Content-Length")).toBeNull();
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    }
  });

  it("leaves HEAD headers alone (no wrong length) but still cleans Vary", async () => {
    const res = await run(() => new Response(null, { status: 200, headers: { "Content-Length": "123", Vary: NEXT_VARY } }), "https://isitbeachday.com/llms.txt", "HEAD").call();
    expect(res.headers.get("Content-Length")).toBe("123");
    expect(res.headers.get("Vary")).toBeNull();
  });

  it("keeps several Set-Cookie headers", async () => {
    const h = new Headers();
    h.append("Set-Cookie", "a=1");
    h.append("Set-Cookie", "b=2");
    const res = await run(() => new Response("x", { headers: h }), "https://isitbeachday.com/api/watch/boca-raton").call();
    expect(res.headers.getSetCookie()).toEqual(["a=1", "b=2"]);
  });

  it("keeps the other handlers of the inner worker (scheduled, queue)", () => {
    const { wrapped } = run(() => new Response("x"), "https://isitbeachday.com/");
    expect((wrapped as { extra?: number }).extra).toBe(7);
  });
});

describe("the wrapper elsewhere", () => {
  it("returns the very same response object for every other path, still streaming", async () => {
    for (const url of ["https://isitbeachday.com/", "https://isitbeachday.com/boca-raton", "https://isitbeachday.com/_next/static/a.js", "https://isitbeachday.com/api/push/run", "https://isitbeachday.com/mcp/x"]) {
      const original = streamed(["<html>", "</html>"], { headers: { Vary: NEXT_VARY, "Transfer-Encoding": "chunked" } });
      const { call } = run(() => original, url);
      const res = await call();
      expect(res, url).toBe(original);
      expect(res.headers.get("Vary"), url).toBe(NEXT_VARY);
      expect(res.headers.get("Content-Length"), url).toBeNull();
    }
  });

  it("does not read the body of a non-agent response", async () => {
    let pulled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled = true;
        c.close();
      },
    }, { highWaterMark: 0 });
    const { call } = run(() => new Response(body), "https://isitbeachday.com/boca-raton");
    await call();
    expect(pulled).toBe(false);
  });
});

describe("bufferResponse", () => {
  it("passes a 1xx-style or websocket response through", async () => {
    const ws = Object.assign(new Response(null, { status: 200 }), { webSocket: {} });
    expect(await bufferResponse(ws, "GET")).toBe(ws);
  });
});
