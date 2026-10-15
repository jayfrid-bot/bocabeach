// A small JSON Schema checker for the subset this project writes by hand: MCP tool
// input schemas, and the OpenAPI response schemas the tests check real answers
// against. Supported: type (name or list), enum, const, properties, required,
// additionalProperties (false), items, minimum, maximum, minLength, maxLength,
// pattern, oneOf / anyOf (at least one branch must fit), and local $ref ("#/components/schemas/Name") when `root` is given.
// Not supported: allOf, format. Unknown keywords are ignored.

export type JsonSchema = {
  type?: string | string[];
  enum?: unknown[];
  const?: unknown;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  $ref?: string;
  oneOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  description?: string;
  [k: string]: unknown;
};

function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v;
}

function resolveRef(ref: string, root: unknown): JsonSchema | null {
  if (!ref.startsWith("#/")) return null;
  let cur: unknown = root;
  for (const part of ref.slice(2).split("/")) {
    if (cur && typeof cur === "object" && part in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[part];
    } else return null;
  }
  return cur as JsonSchema;
}

/** Returns a list of problems; empty means the value fits the schema. */
export function validateJson(value: unknown, schema: JsonSchema, root?: unknown, path = "$"): string[] {
  if (schema.$ref) {
    const target = resolveRef(schema.$ref, root);
    return target ? validateJson(value, target, root, path) : [`${path}: unresolved ${schema.$ref}`];
  }
  const branches = schema.oneOf ?? schema.anyOf;
  if (branches && !branches.some((b) => validateJson(value, b, root, path).length === 0)) {
    return [`${path}: does not match any allowed shape`];
  }
  const errors: string[] = [];
  if (schema.type !== undefined) {
    const allowed = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actual = typeOf(value);
    const ok = allowed.some((t) => t === actual || (t === "number" && actual === "integer"));
    if (!ok) return [`${path}: expected ${allowed.join(" or ")}, got ${actual}`];
  }
  if (schema.const !== undefined && value !== schema.const) errors.push(`${path}: must be ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path}: must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(", ")}`);
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: must be at least ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: must be at most ${schema.maximum}`);
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${path}: too short`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${path}: too long (max ${schema.maxLength})`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${path}: has the wrong format`);
  }
  if (Array.isArray(value) && schema.items) {
    value.forEach((v, i) => errors.push(...validateJson(v, schema.items!, root, `${path}[${i}]`)));
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!(key in obj)) errors.push(`${path}.${key}: is required`);
    }
    for (const [key, v] of Object.entries(obj)) {
      const sub = schema.properties?.[key];
      if (sub) errors.push(...validateJson(v, sub, root, `${path}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${path}.${key}: is not a known field`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
        errors.push(...validateJson(v, schema.additionalProperties, root, `${path}.${key}`));
      }
    }
  }
  return errors;
}
