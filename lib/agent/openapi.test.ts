import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/watchViewCache", () => ({ peekWatchView: vi.fn(), storeWatchView: vi.fn(async () => true) }));

vi.mock("@/lib/conditions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/conditions")>();
  return { ...actual, getConditions: vi.fn() };
});

import { GET as listGET } from "@/app/api/v1/beaches/route";
import { GET as beachGET } from "@/app/api/v1/beaches/[slug]/route";
import { GET as nearestGET } from "@/app/api/v1/nearest/route";
import { getConditions } from "@/lib/conditions";
import { peekWatchView } from "@/lib/watchViewCache";
import { buildLlmsTxt } from "@/lib/agent/llmsTxt";
import { MCP_URL, OPENAPI_PATH, SITE_URL } from "@/lib/agent/constants";
import { buildOpenApi } from "@/lib/agent/openapi";
import {
  BEACH_LIST_QUERY_KEYS,
  NEAREST_QUERY_KEYS,
  parseBool,
  parseInteger,
  parseLat,
  parseLon,
  parseText,
} from "@/lib/agent/params";
import { resetAgentRateLimit } from "@/lib/agent/rateLimit";
import { validateJson, type JsonSchema } from "@/lib/agent/schema";
import { BUILT_MS, conditionsFor, warmView, req } from "@/lib/agent/testkit";

const spec = buildOpenApi();
const ROOT = join(process.cwd(), "app/api/v1");

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return routeFiles(p);
    return name === "route.ts" ? [p] : [];
  });
}
/** app/api/v1/beaches/[slug]/route.ts -> /beaches/{slug} */
const specPathOf = (file: string) =>
  "/" + relative(ROOT, file).split(sep).slice(0, -1).join("/").replace(/\[(\w+)\]/g, "{$1}");

describe("OpenAPI document", () => {
  const files = routeFiles(ROOT);

  it("is OpenAPI 3.1 with the production server URL", () => {
    expect(spec.openapi).toBe("3.1.0");
    expect(spec.servers[0].url).toBe(`${SITE_URL}/api/v1`);
    expect(spec.info.title).toBeTruthy();
  });

  it("has exactly one path for each route file under app/api/v1, and no extras", () => {
    expect(files.length).toBeGreaterThanOrEqual(4);
    expect(Object.keys(spec.paths).sort()).toEqual(files.map(specPathOf).sort());
  });

  it("documents GET only, and every route answers GET, a CORS preflight and the other methods (405)", async () => {
    for (const file of files) {
      const mod = (await import(/* @vite-ignore */ file)) as Record<string, unknown>;
      const documented = Object.keys((spec.paths as Record<string, Record<string, unknown>>)[specPathOf(file)]).sort();
      expect(documented, file).toEqual(["get"]);
      for (const m of ["GET", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"]) {
        expect(typeof mod[m], `${file} exports ${m}`).toBe("function");
      }
    }
  });

  it("documents the same input rules the code enforces", () => {
    type Param = { name: string; schema: { pattern?: string; enum?: string[]; maxLength?: number; minLength?: number } };
    const params = (path: string) => Object.fromEntries(((spec.paths as any)[path].get.parameters as Param[]).map((p) => [p.name, p.schema]));
    const accepts = (schema: Param["schema"], v: string) => (schema.enum ? schema.enum.includes(v) : new RegExp(schema.pattern!).test(v));
    const n = params("/nearest");
    const inputs = [
      "0", "26.35", "-80.07", "10", "05", "026", "+1", " 1", "1 ", "1e1", ".5", "5.", "-0", "-0.0", "-0.00", "0.0", "-0.5", "",
      "true", "false", "1", "TRUE", "11", "3", "26.35\n",
      "89.9999", "90", "90.0", "90.1", "90.0001", "91", "99", "-90", "-90.0", "-90.1", "-91", "100", "179.99", "180", "180.0", "180.1",
      "181", "-180", "-180.5", "-181", "199", "1".repeat(25),
      // Values that only round to an in-range number must be refused, like the pattern refuses them.
      "90." + "0".repeat(20) + "1", "-90." + "0".repeat(19) + "1", "180." + "0".repeat(19) + "1", "89.99999999999999999999", "0." + "1".repeat(22), "0." + "1".repeat(23), "12." + "0".repeat(21),
    ];
    // The runtime parser and the published pattern agree on every one of these.
    for (const v of inputs) {
      const lat = parseLat(v).ok;
      const lon = parseLon(v).ok;
      expect(accepts(n.lat, v), `lat=${JSON.stringify(v)}`).toBe(lat);
      expect(accepts(n.lon, v), `lon=${JSON.stringify(v)}`).toBe(lon);
      expect(accepts(n.limit, v), `limit=${JSON.stringify(v)}`).toBe(parseInteger(v, "limit", 1, 10).ok);
      expect(accepts(n.scores, v), `scores=${JSON.stringify(v)}`).toBe(parseBool(v, "scores").ok);
    }
    // And a sweep of generated numbers around the limits.
    for (let i = -2000; i <= 2000; i += 7) {
      const v = (i / 10).toString();
      expect(accepts(n.lat, v), `lat=${v}`).toBe(parseLat(v).ok);
      expect(accepts(n.lon, v), `lon=${v}`).toBe(parseLon(v).ok);
    }
    const l = params("/beaches");
    for (const v of ["Broward", "Palm Beach", " x", "x ", "", "x".repeat(80), "x".repeat(81)]) {
      const code = parseText(v, "region", 80).ok;
      const doc = v.length >= 1 && v.length <= (l.region.maxLength as number) && accepts(l.region, v);
      expect(doc, JSON.stringify(v.slice(0, 12))).toBe(code);
    }
  });

  it("documents 500 on every operation and Retry-After on the 503", () => {
    for (const p of Object.values(spec.paths) as Array<{ get: { responses: Record<string, any> } }>) {
      expect(p.get.responses).toHaveProperty("500");
    }
    expect((spec.paths as any)["/beaches/{slug}"].get.responses["503"].headers).toHaveProperty("Retry-After");
    expect((spec.paths as any)["/openapi.json"].get.responses).toHaveProperty("400");
  });

  it("makes no claim of an edge response cache and keeps the coordinate wording honest", () => {
    const text = JSON.stringify(spec) + buildLlmsTxt();
    expect(text).not.toMatch(/cached at the edge|edge-cached|at the edge/i);
    expect(text).not.toMatch(/not stored or logged(?! by the app)/);
    expect(text).toMatch(/not store or log the coordinates|not stored or logged by the app/);
  });

  it("lists the same query and path parameters the routes read", () => {
    type Param = { name: string; in: string; required?: boolean };
    const params = (path: string): Param[] => (spec.paths as any)[path].get.parameters ?? [];
    const names = (path: string, where: string) => params(path).filter((p) => p.in === where).map((p) => p.name).sort();
    expect(names("/beaches", "query")).toEqual([...BEACH_LIST_QUERY_KEYS].sort());
    expect(names("/nearest", "query")).toEqual([...NEAREST_QUERY_KEYS].sort());
    expect(names("/beaches/{slug}", "query")).toEqual([]);
    expect(names("/beaches/{slug}", "path")).toEqual(["slug"]);
    expect(params("/nearest").filter((p) => p.required).map((p) => p.name).sort()).toEqual(["lat", "lon"]);
    expect(params("/beaches/{slug}")[0].required).toBe(true);
  });

  it("has unique operation ids, resolvable $refs and an error response on every route", () => {
    const text = JSON.stringify(spec);
    const refs = [...text.matchAll(/"\$ref":"#\/components\/schemas\/(\w+)"/g)].map((m) => m[1]);
    for (const r of refs) expect(spec.components.schemas, r).toHaveProperty(r);
    const ids = Object.values(spec.paths).flatMap((p) => Object.values(p as Record<string, { operationId: string }>).map((o) => o.operationId));
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of Object.values(spec.paths) as Array<{ get: { responses: Record<string, unknown> } }>) {
      expect(p.get.responses).toHaveProperty("200");
      expect(p.get.responses).toHaveProperty("429");
    }
  });

  it("is mentioned, with every path and the MCP URL, in llms.txt", () => {
    const txt = buildLlmsTxt();
    expect(txt).toContain(MCP_URL);
    expect(txt).toContain(`${SITE_URL}${OPENAPI_PATH}`);
    for (const path of Object.keys(spec.paths).filter((p) => p !== "/openapi.json")) {
      expect(txt, path).toContain(`/api/v1${path}`);
    }
    expect(txt).toContain("Lifeguard flags and posted warnings always win.");
    expect(txt).toContain("Score by Is It Beach Day");
  });
});

describe("real answers fit the documented schemas", () => {
  beforeEach(() => {
    resetAgentRateLimit();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.mocked(getConditions).mockImplementation(async (slug: string) => conditionsFor(slug));
    vi.mocked(peekWatchView).mockImplementation(async (slug: string) => warmView(slug));
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(BUILT_MS);
  });
  afterEach(() => {
    vi.mocked(getConditions).mockReset();
    vi.mocked(peekWatchView).mockReset();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const check = (body: unknown, name: string) => {
    const problems = validateJson(body, { $ref: `#/components/schemas/${name}` } as JsonSchema, spec);
    expect(problems, name).toEqual([]);
  };
  const jsonOf = async (p: Promise<Response> | Response) => (await p).json();

  it("GET /beaches", async () => {
    check(await jsonOf(listGET(req("/api/v1/beaches"))), "BeachList");
  });
  it("GET /beaches/{slug}", async () => {
    check(await jsonOf(beachGET(req("/api/v1/beaches/boca-raton"), { params: Promise.resolve({ slug: "boca-raton" }) })), "BeachConditions");
  });
  it("GET /nearest, with and without scores", async () => {
    check(await jsonOf(nearestGET(req("/api/v1/nearest?lat=26.36&lon=-80.06&limit=5"))), "NearestResponse");
    check(await jsonOf(nearestGET(req("/api/v1/nearest?lat=26.36&lon=-80.06&limit=5&scores=true"))), "NearestResponse");
  });
  it("every error answer", async () => {
    const bads = [
      listGET(req("/api/v1/beaches?state=Atlantis")),
      beachGET(req("/api/v1/beaches/nope"), { params: Promise.resolve({ slug: "nope" }) }),
      nearestGET(req("/api/v1/nearest")),
    ];
    for (const r of bads) check(await jsonOf(r), "Error");
  });
  it("the schema checker does catch a drifted answer", async () => {
    const body = await jsonOf(beachGET(req("/api/v1/beaches/boca-raton"), { params: Promise.resolve({ slug: "boca-raton" }) }));
    delete body.safetyNote;
    expect(validateJson(body, { $ref: "#/components/schemas/BeachConditions" } as JsonSchema, spec)).not.toEqual([]);
    body.safetyNote = "x";
    expect(validateJson(body, { $ref: "#/components/schemas/BeachConditions" } as JsonSchema, spec)).not.toEqual([]);
  });
});
