// Shared request handling for the Plus routes (/api/devices, /api/presence).
// Every route answers in one of two shapes and never throws to the client:
//   success  { ok: true, device: DeviceRecord }
//   failure  { ok: false, error: "<slug>" }

import { timingSafeEqual } from "node:crypto";
import type { DeviceRecord } from "@/lib/db/types";

/** Bodies are tiny (a profile at most). Anything larger is a mistake or abuse. */
export const MAX_BODY_BYTES = 8 * 1024;

/** A client-minted UUID v4, or a synthetic "legacy:<base64url>" id. */
const DEVICE_ID_RE = /^[A-Za-z0-9_:.-]{8,128}$/;

export function isDeviceId(v: unknown): v is string {
  return typeof v === "string" && DEVICE_ID_RE.test(v);
}

export function fail(error: string, status: number): Response {
  return Response.json({ ok: false, error }, { status });
}

export function badRequest(): Response {
  return fail("bad-request", 400);
}

export function okDevice(device: DeviceRecord): Response {
  return Response.json({ ok: true, device });
}

/**
 * Parse a JSON object body under the size cap. Returns null for anything that is
 * not a plain object, is too large, or does not parse — callers answer 400.
 */
export async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null;
  let text: string;
  try {
    text = await req.text();
  } catch {
    return null;
  }
  if (!text) return {}; // an empty body is "no fields", not a parse error
  if (byteLength(text) > MAX_BODY_BYTES) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function byteLength(s: string): number {
  return typeof TextEncoder === "undefined"
    ? Buffer.byteLength(s, "utf8")
    : new TextEncoder().encode(s).length;
}

/** Constant-time compare (length-equal), same guard the cron secret uses. */
export function secretEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** A finite number inside [min, max], else null. */
export function num(v: unknown, min: number, max: number): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : null;
}
