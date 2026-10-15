import { describe, expect, it } from "vitest";
import { validateJson, type JsonSchema } from "@/lib/agent/schema";

describe("validateJson", () => {
  const schema: JsonSchema = {
    type: "object",
    required: ["lat"],
    properties: {
      lat: { type: "number", minimum: -90, maximum: 90 },
      limit: { type: "integer", minimum: 1, maximum: 5 },
      slug: { type: "string", pattern: "^[a-z-]+$", maxLength: 8 },
      state: { type: ["string", "null"] },
      list: { type: "array", items: { type: "integer" } },
    },
    additionalProperties: false,
  };

  it("accepts a good object", () => {
    expect(validateJson({ lat: 26.3, limit: 3, slug: "boca", state: null, list: [1, 2] }, schema)).toEqual([]);
  });
  it("names each problem", () => {
    expect(validateJson({}, schema)).toEqual(["$.lat: is required"]);
    expect(validateJson({ lat: "26" }, schema)[0]).toMatch(/expected number/);
    expect(validateJson({ lat: 91 }, schema)[0]).toMatch(/at most 90/);
    expect(validateJson({ lat: 1, limit: 2.5 }, schema)[0]).toMatch(/expected integer/);
    expect(validateJson({ lat: 1, limit: 9 }, schema)[0]).toMatch(/at most 5/);
    expect(validateJson({ lat: 1, slug: "UP" }, schema)[0]).toMatch(/wrong format/);
    expect(validateJson({ lat: 1, slug: "abcdefghij" }, schema)[0]).toMatch(/too long/);
    expect(validateJson({ lat: 1, extra: 1 }, schema)[0]).toMatch(/not a known field/);
    expect(validateJson({ lat: 1, list: [1, "x"] }, schema)[0]).toMatch(/\$\.list\[1\]/);
    expect(validateJson(null, schema)[0]).toMatch(/expected object/);
  });
  it("follows $ref and oneOf", () => {
    const root = { components: { schemas: { N: { type: "integer" } } } };
    const s = { oneOf: [{ $ref: "#/components/schemas/N" }, { type: "null" }] };
    expect(validateJson(3, s, root)).toEqual([]);
    expect(validateJson(null, s, root)).toEqual([]);
    expect(validateJson("x", s, root)).toHaveLength(1);
    expect(validateJson(1, { $ref: "#/nope" }, root)[0]).toMatch(/unresolved/);
  });
});
