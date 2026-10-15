import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/conditions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/conditions")>();
  return { ...actual, getConditions: vi.fn() };
});

import { GET as listGET } from "@/app/api/v1/beaches/route";
import { GET as beachGET } from "@/app/api/v1/beaches/[slug]/route";
import { GET as nearestGET } from "@/app/api/v1/nearest/route";
import { getConditions } from "@/lib/conditions";
import { buildLlmsTxt } from "@/lib/agent/llmsTxt";
import { MCP_URL, OPENAPI_PATH, SITE_URL } from "@/lib/agent/constants";
import { buildOpenApi } from "@/lib/agent/openapi";
import { BEACH_LIST_QUERY_KEYS, NEAREST_QUERY_KEYS } from "@/lib/agent/params";
import { resetAgentRateLimit } from "@/lib/agent/rateLimit";
import { validateJson, type JsonSchema } from "@/lib/agent/schema";
import { BUILT_MS, conditionsFor, req } from "@/lib/agent/testkit";

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

  it("describes the same methods each route exports", async () => {
    for (const file of files) {
      const mod = (await import(/* @vite-ignore */ file)) as Record<string, unknown>;
      const exported = ["GET", "POST", "PUT", "PATCH", "DELETE"].filter((m) => typeof mod[m] === "function").map((m) => m.toLowerCase());
      const documented = Object.keys((spec.paths as Record<string, Record<string, unknown>>)[specPathOf(file)]).sort();
      expect(documented, file).toEqual(exported.sort());
      expect(typeof mod.OPTIONS, `${file} answers CORS preflight`).toBe("function");
    }
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
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(BUILT_MS);
  });
  afterEach(() => {
    vi.mocked(getConditions).mockReset();
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
