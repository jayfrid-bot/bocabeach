// The lean wire form of a conditions response — what the browser is sent.
//
// The full `ConditionsResponse` is built for the server and for external readers
// (/api/conditions/<slug> stays exactly as it was). The page itself needs the same
// numbers but not the same bytes. Three things made the first load heavy:
//
//   1. The snapshot was serialized TWICE in the HTML: once as server-rendered
//      markup and once as the RSC "flight" props that hydrate the dashboard.
//   2. The hourly arrays (216 forecast hours, ~120 marine hours, ~70 NWPS hours)
//      repeat every key name on every row — 60% of their bytes are key names.
//   3. A few fields are produced for the server's own use and no client code
//      reads them (the buoy's 7-day water-temperature series, the two score
//      curves the page recomputes itself).
//
// `toWire` fixes all three; `fromWire` is its exact inverse for everything the
// client reads, so every component downstream still sees a plain
// `ConditionsResponse`. The packing is LOSSLESS for the row arrays (it refuses
// to pack — and sends the rows as they were — if a row holds a real `null`, an
// array, or an object, which it cannot restore exactly).
//
// Pure. No React, no Date.now().

import type { ConditionsResponse } from "@/lib/types";

/** Marker on a packed array. Never a key a real row array has. */
const PACKED = "$packed";

/** One column of a packed row array. */
type Column =
  /** Plain values, `null` where the row had no such field. */
  | { v: (string | number | boolean | null)[] }
  /** ISO timestamps at a fixed stride: `[firstIso, stepMs]`. */
  | { t: [string, number] }
  /** Few distinct strings: `d` is the dictionary, `i` the per-row index (-1 = absent). */
  | { d: string[]; i: number[] };

export interface PackedRows {
  [PACKED]: 1;
  /** Row count. */
  n: number;
  /** Key names, in column order. */
  k: string[];
  c: Column[];
}

export function isPacked(x: unknown): x is PackedRows {
  return !!x && typeof x === "object" && (x as Record<string, unknown>)[PACKED] === 1;
}

type Primitive = string | number | boolean;
const isPrimitive = (v: unknown): v is Primitive =>
  typeof v === "string" || typeof v === "number" || typeof v === "boolean";

/** An ISO string that survives a Date round trip unchanged (so the stride form is exact). */
function isoMs(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const ms = Date.parse(v);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString() === v ? ms : null;
}

function packColumn(values: (Primitive | null)[]): Column {
  const n = values.length;
  // Fixed-stride timestamps (the hourly `time` column): two numbers say it all.
  if (n >= 3 && values.every((v) => isoMs(v) != null)) {
    const first = isoMs(values[0])!;
    const step = isoMs(values[1])! - first;
    if (step > 0 && values.every((v, i) => isoMs(v) === first + i * step)) {
      return { t: [values[0] as string, step] };
    }
  }
  // Repetitive strings (sky words, emoji): a dictionary plus one small int per row.
  if (n >= 8 && values.every((v) => v == null || typeof v === "string")) {
    const dict: string[] = [];
    const idx = new Map<string, number>();
    const out: number[] = [];
    for (const v of values) {
      if (v == null) {
        out.push(-1);
        continue;
      }
      let at = idx.get(v as string);
      if (at === undefined) {
        at = dict.length;
        idx.set(v as string, at);
        dict.push(v as string);
      }
      out.push(at);
    }
    if (dict.length * 4 <= n) return { d: dict, i: out };
  }
  return { v: values };
}

/**
 * Pack an array of flat rows into columns. Returns the rows UNCHANGED when they
 * cannot be restored exactly (nested values, real `null`s) or when there is
 * nothing to gain (fewer than 4 rows).
 */
export function packRows<T extends object>(rows: readonly T[] | undefined): T[] | PackedRows | undefined {
  if (!rows) return rows as undefined;
  if (rows.length < 4) return rows as T[];
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) return rows as T[];
    for (const [k, v] of Object.entries(row)) {
      if (v === undefined) continue; // absent and undefined are the same thing on the wire
      if (!isPrimitive(v)) return rows as T[]; // null / nested: cannot be restored exactly
      if (typeof v === "number" && !Number.isFinite(v)) return rows as T[]; // JSON would turn it into null
      if (!seen.has(k)) {
        seen.add(k);
        keys.push(k);
      }
    }
  }
  const cols: Column[] = keys.map((k) =>
    packColumn(rows.map((r) => {
      const v = (r as Record<string, unknown>)[k];
      return v === undefined ? null : (v as Primitive);
    })),
  );
  return { [PACKED]: 1, n: rows.length, k: keys, c: cols };
}

export function unpackRows<T extends object>(x: readonly T[] | PackedRows | undefined): T[] | undefined {
  if (!x) return x as undefined;
  if (!isPacked(x)) return x as T[];
  const cols = x.c.map((c): (Primitive | null)[] => {
    if ("t" in c) {
      const [first, step] = c.t;
      const t0 = Date.parse(first);
      return Array.from({ length: x.n }, (_, i) => (i === 0 ? first : new Date(t0 + i * step).toISOString()));
    }
    if ("d" in c) return c.i.map((j) => (j < 0 ? null : c.d[j]));
    return c.v;
  });
  const out: T[] = new Array(x.n);
  for (let r = 0; r < x.n; r++) {
    const row: Record<string, Primitive> = {};
    for (let c = 0; c < x.k.length; c++) {
      const v = cols[c][r];
      if (v != null) row[x.k[c]] = v;
    }
    out[r] = row as T;
  }
  return out;
}

// --- The response --------------------------------------------------------------

/**
 * Same keys as `ConditionsResponse`, except the three row arrays may be packed.
 * Typed loosely on purpose: it is a transport shape, never rendered directly.
 */
export type WireConditions = Omit<ConditionsResponse, "snapshot"> & {
  snapshot: Record<string, unknown>;
  /** Present on every wire object so a reader can tell it from a plain response. */
  wire: 1;
};

/** Is this a wire object (as opposed to a plain `ConditionsResponse`)? */
export function isWire(x: unknown): x is WireConditions {
  return !!x && typeof x === "object" && (x as { wire?: unknown }).wire === 1;
}

type Dict = Record<string, unknown>;
const asDict = (v: unknown): Dict | undefined => (v && typeof v === "object" ? (v as Dict) : undefined);

/** Replace `obj[path...]` with `fn(old)`, copying every object on the way down. */
function mapAt(obj: Dict, path: string[], fn: (old: unknown) => unknown): Dict {
  const [head, ...rest] = path;
  const cur = obj[head];
  if (rest.length === 0) {
    if (cur === undefined) return obj;
    return { ...obj, [head]: fn(cur) };
  }
  const child = asDict(cur);
  if (!child) return obj;
  const next = mapAt(child, rest, fn);
  return next === child ? obj : { ...obj, [head]: next };
}

/** The row arrays that get packed, by path inside `snapshot`. */
const PACKED_PATHS: string[][] = [
  ["hourly", "data"],
  ["marine", "data", "hourlyWaves"],
  ["ripNwps", "data", "hours"],
  ["ripRisk", "hours"],
  ["forecast", "data"],
  ["sargassum", "data", "byHour"],
  ["sargassum", "data", "byDay"],
  ["sargassum", "data", "todayReads"],
  ["busyness", "data", "byHour"],
  ["busyness", "data", "byDay"],
];

/**
 * Build the lean wire object for the browser.
 *
 * Drops what no client code reads, then packs the long row arrays. The input is
 * never mutated.
 */
export function toWire(res: ConditionsResponse): WireConditions {
  // Server-only internals never reach any client (see stripInternalSnapshotFields).
  const { budgetAborted: _budgetAborted, hourlyForecast: _forecast, ...rest } = res;
  const { skyAlertCandidates: _candidates, ...publicSnapshot } = rest.snapshot;
  let snapshot: Dict = { ...publicSnapshot };

  // Read only by lib/conditions.ts (it feeds `snapshot.waterTrend`, already computed).
  snapshot = mapAt(snapshot, ["buoy", "data"], (d) => {
    const { waterTempHistory: _history, ...keep } = d as Dict;
    return keep;
  });
  for (const path of PACKED_PATHS) {
    snapshot = mapAt(snapshot, path, (rows) => packRows(rows as object[]));
  }

  return {
    ...rest,
    snapshot,
    // The page recomputes its own curves from the snapshot; nothing reads these.
    hourlyScores: [],
    wire: 1,
  };
}

/** Inverse of `toWire`. A plain `ConditionsResponse` passes through untouched. */
export function fromWire(x: ConditionsResponse | WireConditions): ConditionsResponse {
  if (!isWire(x)) return x as ConditionsResponse;
  const { wire: _wire, ...rest } = x;
  let snapshot = rest.snapshot as Dict;
  for (const path of PACKED_PATHS) {
    snapshot = mapAt(snapshot, path, (rows) => unpackRows(rows as PackedRows));
  }
  return { ...rest, snapshot } as unknown as ConditionsResponse;
}
