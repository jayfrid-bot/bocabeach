#!/usr/bin/env node
// scripts/clef_route_smoke.mjs - smoke-test POST /api/vision/clef with ONE real
// archived frame, before CLEF_FALLBACK=1 turns Clef on in the reader.
//
// Usage (repo root):
//   node scripts/clef_route_smoke.mjs <archived r2_key> [--kind=surface|underwater] [--dry-run]
//   e.g. node scripts/clef_route_smoke.mjs boca-raton/boca-south/2026-10-12/1500Z-ab12cd34-ef56ab78.jpg
//
// What it does:
//   1. wrangler r2 object get --remote (READ-ONLY) fetches the frame from the
//      isitbeachday-cam-frames bucket into a temp dir.
//   2. Shrinks it the way production does (scripts/cam_seaweed.py shrink_for_clef):
//      768 px long side, JPEG q60; 512 px / q50 if still over 120 KB. Uses macOS
//      `sips` (what the backtest used), else ffmpeg.
//   3. POSTs {kind, image} to $CLEF_URL (default https://app.isitbeachday.com/api/vision/clef)
//      with `Authorization: Bearer <token>`. The token is read from
//      ~/.config/isitbeachday/courier.token (override: $CLEF_TOKEN_FILE). It is
//      never printed and never put in an argument list or URL.
//   4. Prints the HTTP status, the mapped reading, and latency (round trip and
//      the route's own latencyMs). Never prints the image or the token.
//
// --dry-run stops after step 2 (prints sizes). Exit code 0 only on a 200 with ok:true.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const R2_BUCKET = "isitbeachday-cam-frames";
const CLEF_URL = process.env.CLEF_URL || "https://app.isitbeachday.com/api/vision/clef";
const TOKEN_FILE = process.env.CLEF_TOKEN_FILE || path.join(os.homedir(), ".config/isitbeachday/courier.token");
const SMALL = { max: 768, quality: 60 };
const FALLBACK = { max: 512, quality: 50 };
const SMALL_MAX_BYTES = 120 * 1024;

const argv = process.argv.slice(2);
const flags = Object.fromEntries(argv.filter((a) => a.startsWith("--")).map((a) => { const [k, v] = a.slice(2).split("="); return [k, v ?? true]; }));
const key = argv.find((a) => !a.startsWith("--"));
if (!key) {
  console.error("usage: node scripts/clef_route_smoke.mjs <archived r2_key> [--kind=surface|underwater] [--dry-run]");
  process.exit(2);
}
const kind = flags.kind || (key.includes("deerfield-spinner-uw") ? "underwater" : "surface");
if (kind !== "surface" && kind !== "underwater") {
  console.error("--kind must be surface or underwater");
  process.exit(2);
}

function shrink(orig, out, { max, quality }) {
  try {
    execFileSync("sips", ["-s", "format", "jpeg", "-s", "formatOptions", String(quality), "--resampleHeightWidthMax", String(max), orig, "--out", out], { stdio: "ignore" });
  } catch {
    // no sips (not macOS): ffmpeg, qscale chosen to land near libjpeg's quality (same mapping as cam_seaweed.py)
    const q = Math.max(2, Math.min(31, Math.round((100 - quality) / 6.5)));
    const vf = `scale=w='if(gt(iw,ih),min(${max},iw),-2)':h='if(gt(iw,ih),-2,min(${max},ih))'`;
    execFileSync("ffmpeg", ["-v", "error", "-y", "-i", orig, "-frames:v", "1", "-vf", vf, "-pix_fmt", "yuvj420p", "-q:v", String(q), out], { stdio: "ignore" });
  }
}

async function main() {
const work = fs.mkdtempSync(path.join(os.tmpdir(), "clef-smoke-"));
const orig = path.join(work, "orig.jpg");
const small = path.join(work, "small.jpg");
try {
  // 1. fetch (read-only)
  execFileSync("npx", ["wrangler", "r2", "object", "get", `${R2_BUCKET}/${key}`, "--remote", "--file", orig], { cwd: ROOT, stdio: "ignore" });
  if (!fs.existsSync(orig) || fs.statSync(orig).size === 0) throw new Error("could not fetch " + key);
  // 2. shrink like production
  shrink(orig, small, SMALL);
  if (fs.statSync(small).size > SMALL_MAX_BYTES) shrink(orig, small, FALLBACK);
  const bytes = fs.readFileSync(small);
  console.log(`frame: ${key}`);
  console.log(`kind: ${kind}; original ${fs.statSync(orig).size} bytes -> shrunk ${bytes.length} bytes`);
  if (flags["dry-run"]) {
    console.log("dry run: not posting");
    return 0;
  }
  // 3. POST
  let token = "";
  try {
    token = fs.readFileSync(TOKEN_FILE, "utf8").trim();
  } catch {
    // handled below
  }
  if (!token) {
    console.error(`no token in ${TOKEN_FILE} (see the header of scripts/cam_courier_local.sh)`);
    return 2;
  }
  console.log(`POST ${CLEF_URL}`);
  const t0 = Date.now();
  const res = await fetch(CLEF_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ kind, image: bytes.toString("base64") }),
  });
  const roundTripMs = Date.now() - t0;
  const text = await res.text();
  let j = null;
  try {
    j = JSON.parse(text);
  } catch {
    // not JSON
  }
  console.log(`status: ${res.status}`);
  if (!j) {
    console.log(`body (not JSON): ${text.slice(0, 200)}`);
    return 1;
  }
  const { usage, latencyMs, ...reading } = j;
  console.log("reading:", JSON.stringify(reading, null, 2));
  console.log(`latency: round trip ${roundTripMs} ms; route reported ${latencyMs ?? "n/a"} ms; input tokens ${usage?.inputTokens ?? "n/a"}`);
  return res.status === 200 && j.ok === true ? 0 : 1;
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
}

process.exit(await main());
