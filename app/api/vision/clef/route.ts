// POST /api/vision/clef — Cloudflare Clef 27B as a FALLBACK cam reader.
//
// The capture script (scripts/cam_seaweed.py, GitHub Actions) tries Gemini
// first, then this route (when CLEF_FALLBACK=1), then Groq and OpenRouter. It posts one shrunk JPEG
// (768 px long side, quality 60) as base64 inside JSON:
//
//   POST /api/vision/clef            Authorization: Bearer $INGEST_TOKEN
//   { "kind": "surface" | "underwater", "image": "<base64 jpeg>" }
//
// and gets back the reading in the SAME shape cam_seaweed.py's assess() builds
// from any other provider, plus provider, model, usage and latencyMs:
//
//   surface:    { ok, kind, level, coveragePct, note, crowd, crowdPct, people,
//                 crowdNote, water, waterPct, waterNote, unreadable, unreadableP,
//                 provider, model, usage: {inputTokens}, latencyMs }
//   underwater: { ok, kind, level, pct, note, unreadable, unreadableP,
//                 provider, model, usage, latencyMs }
//
// The request Clef receives and the way its answers become a reading live in
// lib/vision/clef.ts, a port of the offline backtest
// (docs/benchmarks/clef-vision-2026-10-12/), so that backtest is the evidence
// for what this route does. Only `clef` 27B; never clef-flash.
//
// Order of work (each step can end the request):
//   1. Bearer INGEST_TOKEN, constant-time compare.            503 unset / 401
//   2. Content-Length over 400 KB refused up front.            413
//   3. Workers AI binding present, else fail closed.           503
//   4. Body read incrementally, aborted past 400 KB.           413 / 400
//   5. JSON { kind, image } well formed, image looks like a
//      base64 JPEG.                                            400
//   6. Per-UTC-day budget: one atomic D1 statement
//      (lib/vision/dailyCap.ts, 600/day). Fails closed.        429 {reason:"daily-cap"} / 503
//   7. env.AI.run(...).                                        502 model-error
//   8. Strict validation of the answers (lib/vision/clef.ts
//      validateClefAnswers), then the mapping. Anything
//      malformed or missing -> never invent a value.           502 unparseable-answer
//   9. 200 with the reading. `Cache-Control: no-store` on every reply.
//
// LOG. The first successful read of each UTC day (per Worker isolate) writes one
// JSON line: event, day, model, kind, latencyMs, inputTokens. Never the image,
// the Authorization header or the answers. It is the canary that the AI binding
// takes our request (see scripts/clef_route_smoke.mjs).

import { secretEqual } from "@/lib/db/api";
import { bearerToken, readBodyCapped } from "@/lib/camFrames/ingest";
import { getD1 } from "@/lib/db/d1Store";
import { getAiBinding } from "@/lib/vision/ai";
import {
  buildClefRequest,
  CLEF_MODEL,
  deriveClef,
  isUnreadable,
  MAX_CLEF_BODY_BYTES,
  surfaceReading,
  underwaterReading,
  unwrapClefResult,
  validateClefAnswers,
  type ClefKind,
} from "@/lib/vision/clef";
import { takeClefDailySlot } from "@/lib/vision/dailyCap";
import { logFirstSuccessOfDay } from "@/lib/vision/firstSuccessLog";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
/** "/9j/" is the base64 of FF D8 FF, the JPEG signature. */
const JPEG_B64_PREFIX = "/9j/";

function reply(body: Record<string, unknown>, status: number, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });
}

function err(error: string, status: number, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}): Response {
  return reply({ ok: false, error, ...extra }, status, headers);
}

export async function POST(req: Request): Promise<Response> {
  // 1. auth
  const token = process.env.INGEST_TOKEN;
  if (!token) return err("clef reader not configured (INGEST_TOKEN unset)", 503);
  if (!secretEqual(bearerToken(req.headers.get("authorization")), token)) return err("unauthorized", 401);

  // 2. size, up front
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_CLEF_BODY_BYTES) return err("too-large", 413);

  // 3. binding, fail closed
  const ai = await getAiBinding();
  if (!ai) return err("workers ai unavailable", 503);

  // 4. body
  const body = await readBodyCapped(req, MAX_CLEF_BODY_BYTES);
  if (!body.ok) {
    if (body.reason === "too-large") return err("too-large", 413);
    return err(body.reason === "empty" ? "empty-body" : "bad-body", 400);
  }

  // 5. shape
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body.bytes));
  } catch {
    return err("bad-json", 400);
  }
  const p = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  const kind = p.kind;
  if (kind !== "surface" && kind !== "underwater") return err("bad-kind", 400);
  const image = p.image;
  if (typeof image !== "string" || image.length < 100 || !BASE64.test(image)) return err("bad-image", 400);
  if (!image.startsWith(JPEG_B64_PREFIX)) return err("not-a-jpeg", 400);

  // 6. budget guard, after validation so a malformed request never burns the allowance
  const cap = await takeClefDailySlot(await getD1());
  if (!cap.allowed) {
    if (cap.reason === "daily-cap") {
      return err("daily-cap", 429, { reason: "daily-cap" }, { "Retry-After": String(cap.retryAfterSec) });
    }
    return err("cap-unavailable", 503, { reason: "cap-unavailable" });
  }

  // 7. the model
  const t0 = Date.now();
  let raw: unknown;
  try {
    raw = await ai.run(CLEF_MODEL, buildClefRequest(kind as ClefKind, image));
  } catch (e) {
    console.error("clef run failed:", e instanceof Error ? e.message.slice(0, 200) : "unknown error");
    return err("model-error", 502);
  }
  const latencyMs = Date.now() - t0;

  // 8. answers -> reading. Never invent a value.
  const { answers, inputTokens } = unwrapClefResult(raw);
  const invalid = validateClefAnswers(answers, kind as ClefKind);
  if (invalid) {
    console.error("clef answers rejected:", invalid.slice(0, 120)); // names a question, never carries a value
    return err("unparseable-answer", 502);
  }
  const meta = {
    provider: "clef",
    model: CLEF_MODEL,
    usage: { inputTokens },
    latencyMs,
  };
  if (kind === "underwater") {
    const d = deriveClef(answers, true);
    const reading = underwaterReading(d);
    if (!d || !reading) return err("unparseable-answer", 502);
    logFirstSuccessOfDay(kind, latencyMs, inputTokens);
    return reply({ ok: true, kind, ...reading, unreadable: isUnreadable(d.unreadableP), unreadableP: d.unreadableP, ...meta }, 200);
  }
  const d = deriveClef(answers, false);
  const reading = surfaceReading(d);
  if (!d || !reading) return err("unparseable-answer", 502);
  logFirstSuccessOfDay(kind, latencyMs, inputTokens);
  return reply({ ok: true, kind, ...reading, unreadable: isUnreadable(d.unreadableP), unreadableP: d.unreadableP, ...meta }, 200);
}
