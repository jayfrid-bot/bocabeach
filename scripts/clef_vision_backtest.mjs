#!/usr/bin/env node
// scripts/clef_vision_backtest.mjs - OFFLINE backtest of Cloudflare's Clef
// (`clef` 27B and `clef-flash` 9B on Workers AI) as a Beach Day cam reader.
//
// Usage (from the repo root):
//   node scripts/clef_vision_backtest.mjs --fetch     # pull frames + cam_reads from D1/R2 (read-only), shrink images
//   node scripts/clef_vision_backtest.mjs --sample    # write the 48-frame answer-key skeleton (no model output seen)
//   node scripts/clef_vision_backtest.mjs --run       # call Clef (paid, cached, budget-capped)
//   node scripts/clef_vision_backtest.mjs --report    # re-score from the cache. NO network, NO cost.
//   --budget=1.00   stop when lifetime Workers AI spend would pass $N (default 1.00)
//   --models=clef,clef-flash   --only=key|matched|all   (what --run covers; default all)
//
// READ-ONLY toward production: `wrangler d1 execute --remote` SELECTs and
// `wrangler r2 object get --remote`. Its only paid calls are Workers AI REST
// calls to Clef. It edits no app code, workflow, or deployed config.
//
// Needs: a wrangler login (OAuth token in
// ~/Library/Preferences/.wrangler/config/default.toml, never printed) and macOS
// `sips`. No npm deps. Images live in $CLEF_WORK (default: os.tmpdir()), never
// in the repo. Raw model replies are cached as small JSON in cache/.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------- config ----
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "docs", "benchmarks", "clef-vision-2026-10-12");
const CACHE = path.join(OUT, "cache");
const DATA = path.join(OUT, "data");
const WORK = process.env.CLEF_WORK || path.join(os.tmpdir(), "clef-vision-2026-10-12");
const ACCOUNT = "10cdd8dec9ac9d0593e31a55eeaee1e2";
const D1_NAME = "isitbeachday-plus";
const R2_BUCKET = "isitbeachday-cam-frames";
const MODELS_ALL = ["clef", "clef-flash"];
// $ per million input tokens (output tokens are not billed). Same table as the
// Dumpster Brain backtest (src/clef-shadow.js there).
const PRICE_PER_M = { clef: 0.24, "clef-flash": 0.09 };
// Cloudflare docs (developers.cloudflare.com/workers-ai/platform/pricing, read 2026-10-12):
// clef $0.240 and 21,818 neurons per M input tokens; clef-flash $0.038 and 3,455 neurons per M.
// The spend cap and the cached `usd` use PRICE_PER_M above (the DB script's table, flash is
// 2.4x too high there, so it is the conservative figure). The report shows both.
const PRICE_DOCS_PER_M = { clef: 0.24, "clef-flash": 0.038 };
const NEURONS_PER_M = { clef: 21818, "clef-flash": 3455 };
const FREE_NEURONS_PER_DAY = 10000;
const CONCURRENCY = 4;
const SMALL = { max: 768, quality: 60 };
const FALLBACK = { max: 512, quality: 50 };
const SMALL_MAX_BYTES = 120 * 1024;
const SEED = "clef-vision-2026-10-12";
const READS_FROM = "2026-10-11";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] === undefined ? true : m[2]] : [a, true];
  })
);
const BUDGET_USD = Number(args.budget || 1.0);
const MODELS = args.models ? String(args.models).split(",") : MODELS_ALL;
const ONLY = args.only || "all";

const log = (...a) => console.log(...a);
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round = (x, d = 3) => (x == null || !Number.isFinite(x) ? null : Number(x.toFixed(d)));
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const median = (a) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const pctile = (a, p) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};
function rng(seed) {
  let h = parseInt(sha(seed).slice(0, 8), 16) >>> 0;
  return () => {
    h = (h + 0x6d2b79f5) >>> 0;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const shuffled = (arr, r) => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
const readJson = (f, dflt = null) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : dflt);

// ------------------------------------------------------------ cam families ---
// From config/vision-cams.json + config/archive-cams.json (feed base / courier).
const FAMILY = {
  "boca-south": "Boca feed",
  "boca-south-surf": "Boca feed",
  "boca-inlet": "Boca inlet feed",
  "boca-inlet-north": "Boca inlet feed",
  "boca-inlet-surf": "Boca inlet feed",
  "boca-inlet-jetty": "Boca inlet feed",
  "deerfield-beach-cam": "Deerfield YouTube courier",
  "deerfield-pier-cam": "Deerfield YouTube courier",
  "deerfield-surf-cam": "Deerfield YouTube courier",
  "ftl-elbo-beach-cam": "Elbo Room courier",
  "deerfield-spinner-uw": "Spinner underwater",
};
const FAMILIES = ["Boca feed", "Boca inlet feed", "Deerfield YouTube courier", "Elbo Room courier", "Spinner underwater"];
const UW_CAM = "deerfield-spinner-uw";

// ----------------------------------------------------- production rubric -----
// Text below is copied from scripts/cam_seaweed.py (PROMPT and UW_PROMPT).
// Clef takes structured questions (yes/no, choice, score), not one free-form
// prompt, so each part of the prompt is carried VERBATIM in the instruction or
// criteria of the matching question. Where Clef cannot return what the prompt
// asks (integers, percents), a `score` question over the prompt's own anchor
// bands stands in, and the number is interpolated from the probabilities.
const SEAWEED = ["none", "low", "moderate", "high"];
const CROWD = ["empty", "quiet", "moderate", "busy", "packed"];
const WATER = ["clear", "slightly_murky", "murky", "churned"];
const UWC = ["clear", "slightly_hazy", "hazy", "murky"];

// anchor bands -> a representative number for each band
const BANDS = {
  seaweed_pct: { v: [0, 5, 30, 60, 95], c: ["0 = clean", "5 = thin wrack line", "30 = clear bands", "60 = heavy mats", "90+ = nearly all covered"] },
  crowd_pct: { v: [0, 25, 50, 75, 100], c: ["0 = empty", "25 = quiet, a few people", "50 = moderate, steady", "75 = busy, crowded", "100 = packed holiday peak"] },
  people: { v: [0, 2, 7, 18, 43, 105, 200], c: ["0 people", "1 to 3 people", "4 to 10 people", "11 to 25 people", "26 to 60 people", "61 to 150 people", "more than 150 people"] },
  water_pct: {
    v: [10, 30, 50, 67, 82, 95],
    c: [
      "<20 = opaque",
      "20-39 = poor, brown or heavily suspended",
      "40-59 = noticeably murky/sandy",
      "60-74 = decent but visibly tinted green, a typical fair day",
      "75-89 = very clear blue-green",
      "90-100 = exceptional glass-clear tropical water (rare here)",
    ],
  },
  uw_pct: { v: [10, 30, 50, 70, 90], c: ["0-20 = opaque", "20-40 = murky", "40-60 = hazy", "60-80 = slightly hazy", "80-100 = gin-clear"] },
};

export function beachQuestions() {
  return {
    seaweed: {
      type: "choice",
      instructions:
        "Seaweed = brown/golden sargassum on the sand and in shallow water. Which level is visible? none=clean sand, low=thin wrack line or scattered patches, moderate=clear bands, high=heavy mats over much of the shore.",
      criteria: {
        none: "Clean sand.",
        low: "Thin wrack line or scattered patches.",
        moderate: "Clear bands.",
        high: "Heavy mats over much of the shore.",
      },
    },
    seaweed_pct: {
      type: "score",
      instructions:
        "seaweed_pct = percent of the visible sand/shoreline covered by sargassum (0=clean, 5=thin wrack line, 30=clear bands, 60=heavy mats, 90+=nearly all covered).",
      criteria: BANDS.seaweed_pct.c,
    },
    crowd: {
      type: "choice",
      instructions:
        "Crowd = how busy the beach looks from people on the sand and in the water (and cars in any visible parking lot): empty=nobody, quiet=a few people, moderate=steady, busy=crowded, packed=very crowded.",
      criteria: {
        empty: "Nobody.",
        quiet: "A few people.",
        moderate: "Steady.",
        busy: "Crowded.",
        packed: "Very crowded.",
      },
    },
    crowd_pct: {
      type: "score",
      instructions: "crowd_pct = how full the beach looks, 0=empty to 100=packed holiday peak.",
      criteria: BANDS.crowd_pct.c,
    },
    people: {
      type: "score",
      instructions: "people = approx visible people (count everyone on the sand and in the water).",
      criteria: BANDS.people.c,
    },
    water: {
      type: "choice",
      instructions:
        "Water = how clear the OCEAN WATER itself looks where it is visible (judge color and transparency of the water beyond the breaking surf, not whitewater foam). IMPORTANT: floating seaweed patches and brown seaweed mats are NOT murkiness - seaweed is graded separately; judge the water transparency in areas FREE of seaweed, and don't let sun glare or surface brightness read as murk. Use unknown if open water is not clearly visible in this frame.",
      criteria: {
        clear: "Blue-green and transparent.",
        slightly_murky: "Greenish with some suspended sand.",
        murky: "Brown/tea-colored water itself.",
        churned: "Heavily stirred-up sand throughout.",
        unknown: "Open water is not clearly visible in this frame.",
      },
    },
    water_pct: {
      type: "score",
      instructions:
        "water_pct = water clarity 0-100. Use the FULL scale and discriminate. Most days fall 55-80 - reserve 85+ for genuinely exceptional transparency.",
      criteria: BANDS.water_pct.c,
    },
    // Extra (not in the production prompt): lets us score "unreadable" agreement.
    unreadable: {
      type: "noul",
      instructions: "Is this frame too dark, blurred, or blocked to read anything reliably (night, lens covered, no view of the beach or water)?",
    },
  };
}
export function uwQuestions() {
  return {
    uw_clarity: {
      type: "choice",
      instructions:
        "Judge how far you can SEE through the water: clear=fish/structures/pilings crisp at distance, slightly_hazy=objects visible but soft, hazy=only near objects visible, murky=heavy particulates, little visibility.",
      criteria: {
        clear: "Fish/structures/pilings crisp at distance.",
        slightly_hazy: "Objects visible but soft.",
        hazy: "Only near objects visible.",
        murky: "Heavy particulates, little visibility.",
      },
    },
    uw_pct: {
      type: "score",
      instructions: "uw_pct = underwater visibility 0-100 where 100=gin-clear and 0=opaque.",
      criteria: BANDS.uw_pct.c,
    },
    unreadable: {
      type: "noul",
      instructions: "If the frame is too dark to judge (night/no light), answer yes. Is this frame too dark to judge?",
    },
  };
}
const beachState = () => ({ task: "This is a live beach webcam photo. Read it with the rubric in the questions.", photos: "One photo: this frame." });
const uwState = () => ({
  task: "This is a frame from an UNDERWATER ocean webcam (a camera submerged off a fishing pier, looking through the water).",
  photos: "One photo: this frame.",
});
const bodyFor = (f, uri) => {
  const uw = f.cam_id === UW_CAM;
  return { state: uw ? uwState() : beachState(), images: [uri], questions: uw ? uwQuestions() : beachQuestions() };
};

// ----------------------------------------------------------- ids and data ----
export const frameId = (f) => {
  const m = f.r2_key.match(/([^/]+)\/(\d{4}-\d{2}-\d{2})\/(\d{4}Z)/);
  return m ? `${m[1]}/${m[2]}/${m[3]}` : f.r2_key;
};
const frames = () => readJson(path.join(DATA, "frames.json"), []);
const reads = () => readJson(path.join(DATA, "reads.json"), []);
const P = (s) => new Date(s).getTime();

// Match each cam_reads row to an archived frame. 1) same cam and the read's
// frameAt equals the frame's frame_at_utc; 2) else same cam and the read is
// within 10 minutes of the frame's display_at_utc (nearest wins).
export function matchReads(frs, rds) {
  const byCam = {};
  for (const f of frs) (byCam[f.cam_id] ||= []).push(f);
  const out = [];
  let exact = 0;
  let timeMatch = 0;
  let none = 0;
  for (const r of rds) {
    let j = {};
    try {
      j = JSON.parse(r.raw_json);
    } catch (e) {
      // keep {}
    }
    const cand = byCam[r.cam_id] || [];
    let hit = j.frameAt ? cand.find((f) => P(f.frame_at_utc) === P(j.frameAt)) : null;
    let how = "frameAt";
    if (!hit) {
      const near = cand
        .map((f) => ({ f, d: Math.abs(P(r.captured_at_utc) - P(f.display_at_utc)) }))
        .filter((x) => x.d <= 10 * 60 * 1000)
        .sort((a, b) => a.d - b.d)[0];
      hit = near ? near.f : null;
      how = "time";
    }
    if (!hit) {
      none++;
      continue;
    }
    how === "frameAt" ? exact++ : timeMatch++;
    out.push({
      frameId: frameId(hit),
      how,
      provider: j.provider || "unknown",
      model: j.model || "unknown",
      read: {
        seaweed: r.seaweed_level,
        covPct: r.cov_pct,
        crowd: r.crowd_level,
        crowdPct: r.crowd_pct,
        people: r.people,
        water: r.water_word,
        waterPct: r.water_pct,
      },
      capturedAt: r.captured_at_utc,
    });
  }
  return { matches: out, stats: { reads: rds.length, matchedByFrameAt: exact, matchedByTime: timeMatch, unmatched: none } };
}

// -------------------------------------------------------- wrangler (RO) ------
function d1(sql) {
  const out = execFileSync("npx", ["wrangler", "d1", "execute", D1_NAME, "--remote", "--json", "--command", sql], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const i = out.indexOf("[");
  return JSON.parse(out.slice(i))[0].results;
}
function r2Get(key, file) {
  return new Promise((resolve) => {
    const p = spawn("npx", ["wrangler", "r2", "object", "get", `${R2_BUCKET}/${key}`, "--remote", "--file", file], { cwd: ROOT, stdio: "ignore" });
    p.on("exit", (c) => resolve(c === 0));
    p.on("error", () => resolve(false));
  });
}
async function pool(items, n, fn) {
  const res = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (i < items.length) {
        const k = i++;
        res[k] = await fn(items[k], k);
      }
    })
  );
  return res;
}

// -------------------------------------------------------------- images -------
const origPath = (f) => path.join(WORK, "orig", frameId(f).replaceAll("/", "_") + ".jpg");
const smallPath = (f) => path.join(WORK, "small", frameId(f).replaceAll("/", "_") + ".jpg");
function shrink(orig, out, { max, quality }) {
  execFileSync("sips", ["-s", "format", "jpeg", "-s", "formatOptions", String(quality), "--resampleHeightWidthMax", String(max), orig, "--out", out], {
    stdio: "ignore",
  });
}
function ensureSmall(f) {
  const orig = origPath(f);
  const small = smallPath(f);
  fs.mkdirSync(path.dirname(small), { recursive: true });
  if (!fs.existsSync(orig)) return { error: "original missing" };
  if (!fs.existsSync(small)) {
    shrink(orig, small, SMALL);
    if (fs.statSync(small).size > SMALL_MAX_BYTES) shrink(orig, small, FALLBACK);
  }
  const bytes = fs.readFileSync(small);
  return { bytes: bytes.length, hash: sha(bytes).slice(0, 16), uri: "data:image/jpeg;base64," + bytes.toString("base64") };
}

async function doFetch() {
  fs.mkdirSync(DATA, { recursive: true });
  fs.mkdirSync(path.join(WORK, "orig"), { recursive: true });
  const fr = d1(
    "SELECT slug,cam_id,slot_utc,frame_at_utc,display_at_utc,local_date,local_hour,local_minute,r2_key,slot_kind FROM cam_frames WHERE state='ready' ORDER BY slug,cam_id,slot_utc"
  );
  const rd = d1(`SELECT * FROM cam_reads WHERE captured_at_utc >= '${READS_FROM}' ORDER BY captured_at_utc`);
  fs.writeFileSync(path.join(DATA, "frames.json"), JSON.stringify(fr));
  fs.writeFileSync(path.join(DATA, "reads.json"), JSON.stringify(rd));
  log(`frames ${fr.length}, cam_reads since ${READS_FROM}: ${rd.length}`);
  let got = 0;
  await pool(fr, 6, async (f) => {
    const o = origPath(f);
    if (fs.existsSync(o) && fs.statSync(o).size > 0) return;
    if (await r2Get(f.r2_key, o)) got++;
    else log("  r2 get failed:", frameId(f));
  });
  let small = 0;
  let fb = 0;
  for (const f of fr) {
    const r = ensureSmall(f);
    if (r.error) continue;
    small++;
    if (r.bytes > SMALL_MAX_BYTES) fb++;
  }
  log(`downloaded ${got} new originals; ${small} shrunk (${fb} still over ${SMALL_MAX_BYTES} bytes)`);
}

// ------------------------------------------------------------- sampling ------
function category(f) {
  const h = f.local_hour;
  if (h <= 6 || h >= 19) return f.slot_kind === "golden" && h >= 19 ? "golden" : "night";
  if (f.slot_kind === "golden") return "golden";
  if (h <= 10) return "morning";
  if (h <= 15) return "midday";
  return "late";
}
// 4 frames per cam (44) + 4 extra midday frames from the people cams = 48.
// Night frames: one each from five cams only, so "dark" stays a small slice.
function doSample() {
  const fr = frames();
  const { matches } = matchReads(fr, reads());
  const hasRead = new Set(matches.map((m) => m.frameId));
  const cams = [...new Set(fr.map((f) => f.cam_id))].sort();
  const nightCams = new Set(["boca-south", "boca-inlet-surf", "deerfield-beach-cam", "ftl-elbo-beach-cam", UW_CAM]);
  const extraCams = ["boca-south", "boca-south-surf", "deerfield-beach-cam", "ftl-elbo-beach-cam"];
  const picked = [];
  const used = new Set();
  const take = (cam, cat, r) => {
    const pool0 = fr.filter((f) => f.cam_id === cam && !used.has(frameId(f)));
    const inCat = pool0.filter((f) => category(f) === cat);
    // prefer frames that have a production read, so Gemini can be checked on them
    const pref = shuffled(inCat.filter((f) => hasRead.has(frameId(f))), r).concat(shuffled(inCat.filter((f) => !hasRead.has(frameId(f))), r));
    return pref[0] || null;
  };
  for (const cam of cams) {
    const r = rng(`${SEED}:${cam}`);
    const plan = nightCams.has(cam) ? ["night", "golden", "midday", "morning"] : ["golden", "midday", "morning", "late"];
    for (const cat of plan) {
      let f = take(cam, cat, r);
      if (!f) {
        for (const alt of ["midday", "morning", "late", "golden", "night"]) {
          f = take(cam, alt, r);
          if (f) break;
        }
      }
      if (f) {
        used.add(frameId(f));
        picked.push({ f, cat: category(f) });
      }
    }
  }
  for (const cam of extraCams) {
    const r = rng(`${SEED}:extra:${cam}`);
    const f = take(cam, "midday", r) || take(cam, "morning", r) || take(cam, "late", r);
    if (f) {
      used.add(frameId(f));
      picked.push({ f, cat: category(f) });
    }
  }
  picked.sort((a, b) => (frameId(a.f) < frameId(b.f) ? -1 : 1));
  const skeleton = picked.map(({ f, cat }) => ({
    frameId: frameId(f),
    cam: f.cam_id,
    family: FAMILY[f.cam_id],
    localDate: f.local_date,
    localTimeET: `${String(f.local_hour).padStart(2, "0")}:${String(f.local_minute).padStart(2, "0")}`,
    slotKind: f.slot_kind,
    stratum: cat,
  }));
  fs.writeFileSync(path.join(OUT, "answer-key-skeleton.json"), JSON.stringify(skeleton, null, 1));
  log(`wrote answer-key-skeleton.json with ${skeleton.length} frames`);
}

// ----------------------------------------------------------- Clef calls ------
function cfToken() {
  const f = path.join(os.homedir(), "Library/Preferences/.wrangler/config/default.toml");
  const m = fs.readFileSync(f, "utf8").match(/^oauth_token\s*=\s*"([^"]+)"/m);
  if (!m) throw new Error("oauth_token not found in wrangler config");
  return m[1];
}
let CF_TOKEN = null;
let refreshedOnce = false;
function refreshCfToken() {
  try {
    execFileSync("npx", ["wrangler", "whoami"], { cwd: ROOT, stdio: "ignore", timeout: 120000 });
  } catch (e) {
    // ignore; re-read whatever is on disk
  }
  CF_TOKEN = cfToken();
}
function lifetimeSpend() {
  let usd = 0;
  if (!fs.existsSync(CACHE)) return 0;
  for (const f of fs.readdirSync(CACHE)) {
    if (!f.endsWith(".json") || f.endsWith(".err.json")) continue;
    try {
      usd += readJson(path.join(CACHE, f)).usd || 0;
    } catch (e) {
      // ignore
    }
  }
  return usd;
}
const SPEND = { lifetime: 0, thisRun: 0, stopped: false };

async function clefRest(model, body) {
  if (!CF_TOKEN) CF_TOKEN = cfToken();
  const url = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/run/@cf/cloudflare/${model}`;
  let lastErr = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    const t0 = Date.now();
    try {
      const res = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${CF_TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const latencyMs = Date.now() - t0;
      const text = await res.text();
      let j = null;
      try {
        j = JSON.parse(text);
      } catch (e) {
        // not JSON
      }
      if ((res.status === 401 || res.status === 403) && !refreshedOnce) {
        refreshedOnce = true;
        log("auth error from Cloudflare; refreshing the wrangler login once");
        refreshCfToken();
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        lastErr = { error: `HTTP ${res.status}: ${text.slice(0, 160)}`, latencyMs };
        await sleep(1000 * 2 ** attempt + Math.random() * 500);
        continue;
      }
      if (!res.ok || !j || j.success === false || !j.result || !j.result.answers) {
        const msg = j && j.errors && j.errors[0] ? `${j.errors[0].code}: ${j.errors[0].message}` : text.slice(0, 200);
        return { error: `HTTP ${res.status}: ${msg}`.slice(0, 300), latencyMs };
      }
      const tokens = j.result.usage && j.result.usage.input_tokens;
      return { answers: j.result.answers, tokens: typeof tokens === "number" ? tokens : null, latencyMs };
    } catch (e) {
      lastErr = { error: "network: " + String(e.message || e).slice(0, 200) };
      await sleep(1000 * 2 ** attempt);
    }
  }
  return lastErr || { error: "retries exhausted" };
}

const cacheFile = (model, f, hash, body) => {
  const qh = sha(JSON.stringify([body.state, body.questions])).slice(0, 10);
  return path.join(CACHE, `${model}_${frameId(f).replaceAll("/", "_")}_${hash.slice(0, 8)}_${qh}.json`);
};

async function callOne(model, f) {
  const img = ensureSmall(f);
  if (img.error) return { error: img.error };
  const body = bodyFor(f, img.uri);
  const file = cacheFile(model, f, img.hash, body);
  if (fs.existsSync(file)) return { ...readJson(file), cached: true };
  if (args.report) return { error: "not in cache (report-only run)" };
  if (SPEND.stopped || SPEND.lifetime + SPEND.thisRun >= BUDGET_USD) {
    SPEND.stopped = true;
    return { error: "skipped: budget stop" };
  }
  const r = await clefRest(model, { model, ...body });
  if (r.error) {
    fs.writeFileSync(file.replace(/\.json$/, ".err.json"), JSON.stringify({ model, frameId: frameId(f), error: r.error, latencyMs: r.latencyMs ?? null, at: new Date().toISOString() }));
    return { error: r.error };
  }
  const usd = r.tokens == null ? 0 : (r.tokens * PRICE_PER_M[model]) / 1e6;
  SPEND.thisRun += usd;
  const rec = {
    model,
    frameId: frameId(f),
    cam: f.cam_id,
    answers: r.answers,
    tokens: r.tokens,
    usd,
    latencyMs: r.latencyMs,
    imageBytes: img.bytes,
    at: new Date().toISOString(),
  };
  fs.writeFileSync(file, JSON.stringify(rec));
  return { ...rec, cached: false };
}

async function doRun() {
  fs.mkdirSync(CACHE, { recursive: true });
  if (new Date(fs.readFileSync(path.join(os.homedir(), "Library/Preferences/.wrangler/config/default.toml"), "utf8").match(/expiration_time\s*=\s*"([^"]+)"/)?.[1] || 0) - Date.now() < 15 * 60 * 1000) {
    log("wrangler token near expiry; refreshing");
    refreshCfToken();
  }
  SPEND.lifetime = lifetimeSpend();
  const fr = frames();
  const key = readJson(path.join(OUT, "answer-key.json"), { frames: [] }).frames.map((x) => x.frameId);
  const { matches } = matchReads(fr, reads());
  const matched = new Set(matches.map((m) => m.frameId));
  const keySet = new Set(key);
  const want = fr.filter((f) => {
    const id = frameId(f);
    if (ONLY === "key") return keySet.has(id);
    if (ONLY === "matched") return matched.has(id);
    return true;
  });
  // order: answer-key and matched frames first, so a budget stop cuts the extras
  want.sort((a, b) => {
    const pa = keySet.has(frameId(a)) || matched.has(frameId(a)) ? 0 : 1;
    const pb = keySet.has(frameId(b)) || matched.has(frameId(b)) ? 0 : 1;
    return pa - pb;
  });
  const jobs = [];
  for (const f of want) for (const m of MODELS) jobs.push({ f, m });
  log(`${jobs.length} calls planned (${want.length} frames x ${MODELS.length} models); lifetime spend so far $${SPEND.lifetime.toFixed(4)}; budget $${BUDGET_USD}`);
  let done = 0;
  let failed = 0;
  await pool(jobs, CONCURRENCY, async ({ f, m }) => {
    const r = await callOne(m, f);
    done++;
    if (r.error) {
      failed++;
      if (!/budget/.test(r.error)) log(`  ${m} ${frameId(f)}: ${r.error}`);
    }
    if (done % 20 === 0 || done === jobs.length) log(`  ${done}/${jobs.length} done, ${failed} failed, running cost $${(SPEND.lifetime + SPEND.thisRun).toFixed(4)}`);
  });
  const total = lifetimeSpend();
  log(`finished. This run $${SPEND.thisRun.toFixed(4)}; lifetime $${total.toFixed(4)}${SPEND.stopped ? " (BUDGET STOP hit)" : ""}`);
  fs.writeFileSync(path.join(OUT, "spend.json"), JSON.stringify({ lifetimeUsd: round(total, 5), budgetUsd: BUDGET_USD, updated: new Date().toISOString() }, null, 1));
}

// ---------------------------------------------------------- reading answers --
// probability-weighted position on a score question, then interpolated onto
// the band values (so a 50/50 split between two bands lands between them)
function scoreValue(a, values) {
  if (!a || typeof a !== "object") return null;
  const probs = a.probabilities;
  let e = null;
  if (probs && typeof probs === "object") {
    let sum = 0;
    let w = 0;
    for (const k of Object.keys(probs)) {
      const lv = Number(k);
      const p = Number(probs[k]);
      if (!Number.isFinite(lv) || !Number.isFinite(p) || p < 0) continue;
      sum += p;
      w += lv * p;
    }
    if (sum > 0) e = w / sum;
  }
  if (e == null && typeof a.score === "number") e = a.score;
  if (e == null) return null;
  const idx = Math.max(0, Math.min(values.length - 1, e));
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return values[lo] + (values[hi] - values[lo]) * (idx - lo);
}
const choiceOf = (a, allowed) => (a && typeof a.choice === "string" && allowed.includes(a.choice) ? a.choice : null);
const noul = (a) => (a && typeof a.noul === "number" ? a.noul : null);

// Clef answers -> the same shape as the production reading. null = missing/bad.
export function deriveClef(ans, uw) {
  if (!ans) return null;
  if (uw) {
    const lvl = choiceOf(ans.uw_clarity, UWC);
    const pct = scoreValue(ans.uw_pct, BANDS.uw_pct.v);
    return { uwLevel: lvl, uwPct: pct == null ? null : Math.round(pct), unreadableP: noul(ans.unreadable), ok: lvl != null && pct != null && noul(ans.unreadable) != null };
  }
  const seaweed = choiceOf(ans.seaweed, SEAWEED);
  const crowd = choiceOf(ans.crowd, CROWD);
  const water = choiceOf(ans.water, [...WATER, "unknown"]);
  const cov = scoreValue(ans.seaweed_pct, BANDS.seaweed_pct.v);
  const cp = scoreValue(ans.crowd_pct, BANDS.crowd_pct.v);
  const ppl = scoreValue(ans.people, BANDS.people.v);
  const wp = scoreValue(ans.water_pct, BANDS.water_pct.v);
  const un = noul(ans.unreadable);
  const r = {
    seaweed,
    covPct: cov == null ? null : Math.round(cov),
    crowd,
    crowdPct: cp == null ? null : Math.round(cp),
    people: ppl == null ? null : Math.round(ppl),
    water: water === "unknown" ? null : water,
    waterUnknown: water === "unknown",
    waterPct: wp == null ? null : Math.round(wp),
    unreadableP: un,
  };
  r.ok = seaweed != null && crowd != null && water != null && cov != null && cp != null && ppl != null && wp != null && un != null;
  return r;
}

// ---------------------------------------------------------------- metrics ----
function ord(pairs, ranks) {
  // pairs: [{a: modelValue, b: referenceValue}] ; reference must be known
  const use = pairs.filter((p) => p.b != null && ranks.includes(p.b));
  const exact = use.filter((p) => p.a === p.b).length;
  const within = use.filter((p) => p.a != null && ranks.includes(p.a) && Math.abs(ranks.indexOf(p.a) - ranks.indexOf(p.b)) <= 1).length;
  return { n: use.length, exact: use.length ? exact / use.length : null, within1: use.length ? within / use.length : null };
}
function mae(pairs) {
  const use = pairs.filter((p) => typeof p.a === "number" && typeof p.b === "number");
  if (!use.length) return { n: 0, mae: null, bias: null, r: null };
  let r = null;
  if (use.length >= 5) {
    const ma = mean(use.map((p) => p.a));
    const mb = mean(use.map((p) => p.b));
    const num = use.reduce((t, p) => t + (p.a - ma) * (p.b - mb), 0);
    const da = Math.sqrt(use.reduce((t, p) => t + (p.a - ma) ** 2, 0));
    const db = Math.sqrt(use.reduce((t, p) => t + (p.b - mb) ** 2, 0));
    r = da > 0 && db > 0 ? num / (da * db) : null;
  }
  return { n: use.length, mae: mean(use.map((p) => Math.abs(p.a - p.b))), bias: mean(use.map((p) => p.a - p.b)), r };
}
// rows: [{model: derived-reading, ref: reference-reading}] (beach cams)
function fieldMetrics(rows) {
  const g = (k) => rows.map((r) => ({ a: r.model[k], b: r.ref[k] }));
  const ppl5 = rows.filter((r) => typeof r.ref.people === "number" && r.ref.people >= 5).map((r) => ({ a: r.model.people, b: r.ref.people }));
  return {
    seaweed: ord(g("seaweed"), SEAWEED),
    cov: mae(g("covPct")),
    crowd: ord(g("crowd"), CROWD),
    crowdPct: mae(g("crowdPct")),
    people: mae(g("people")),
    people5: mae(ppl5),
    water: ord(g("water"), WATER),
    waterPct: mae(g("waterPct")),
  };
}
function unknownAgree(rows) {
  // water unknown (open water not visible): reference vs model
  const use = rows.filter((r) => r.refUnknown != null);
  const tp = use.filter((r) => r.refUnknown && r.modelUnknown).length;
  const fn = use.filter((r) => r.refUnknown && !r.modelUnknown).length;
  const fp = use.filter((r) => !r.refUnknown && r.modelUnknown).length;
  const tn = use.filter((r) => !r.refUnknown && !r.modelUnknown).length;
  return { n: use.length, tp, fn, fp, tn, acc: use.length ? (tp + tn) / use.length : null };
}

// ------------------------------------------------------------------ report ---
const f1 = (x) => (x == null ? "-" : (x * 100).toFixed(0) + "%");
const f2 = (x) => (x == null ? "-" : x.toFixed(1));
const fmtOrd = (m) => (m.n ? `${f1(m.exact)} / ${f1(m.within1)} (n=${m.n})` : "-");
const fmtMae = (m) => (m.n ? `${f2(m.mae)}, bias ${m.bias >= 0 ? "+" : ""}${f2(m.bias)}${m.r == null ? "" : `, r=${m.r.toFixed(2)}`} (n=${m.n})` : "-");

function loadCalls(frs) {
  const byKey = {};
  for (const f of frs) for (const m of MODELS_ALL) byKey[`${m}|${frameId(f)}`] = null;
  const errs = {};
  if (fs.existsSync(CACHE)) {
    for (const file of fs.readdirSync(CACHE)) {
      const j = readJson(path.join(CACHE, file));
      if (!j) continue;
      if (file.endsWith(".err.json")) {
        errs[`${j.model}|${j.frameId}`] = j;
        continue;
      }
      if (j.model && j.frameId) byKey[`${j.model}|${j.frameId}`] = j;
    }
  }
  return { byKey, errs };
}

function doReport() {
  const frs = frames();
  const rds = reads();
  const { matches, stats } = matchReads(frs, rds);
  const keyFile = readJson(path.join(OUT, "answer-key.json"), { frames: [] });
  const keyById = Object.fromEntries(keyFile.frames.map((k) => [k.frameId, k]));
  const frameById = Object.fromEntries(frs.map((f) => [frameId(f), f]));
  const { byKey, errs } = loadCalls(frs);
  const summary = { matchStats: stats, models: {} };

  // ---- run facts / cost / latency / parse rate
  const costRows = [];
  for (const m of MODELS_ALL) {
    const ok = Object.entries(byKey).filter(([k, v]) => k.startsWith(m + "|") && v);
    const bad = Object.keys(errs).filter((k) => k.startsWith(m + "|") && !byKey[k]);
    const derived = ok.map(([k, v]) => deriveClef(v.answers, v.cam === UW_CAM));
    const malformed = derived.filter((d) => !d || !d.ok).length;
    const lat = ok.map(([, v]) => v.latencyMs).filter((x) => typeof x === "number");
    const tok = ok.map(([, v]) => v.tokens).filter((x) => typeof x === "number");
    const usd = ok.map(([, v]) => v.usd).filter((x) => typeof x === "number");
    const row = {
      model: m,
      calls: ok.length + bad.length,
      answered: ok.length,
      apiFailures: bad.length,
      malformed,
      failRate: ok.length + bad.length ? (bad.length + malformed) / (ok.length + bad.length) : null,
      latP50: median(lat),
      latP95: pctile(lat, 95),
      tokMean: mean(tok),
      usdMean: mean(usd),
      usdTotal: usd.reduce((a, b) => a + b, 0),
      monthly300: mean(usd) == null ? null : mean(usd) * 300 * 30,
      docsUsdMean: mean(tok) == null ? null : (mean(tok) * PRICE_DOCS_PER_M[m]) / 1e6,
      neuronsMean: mean(tok) == null ? null : (mean(tok) * NEURONS_PER_M[m]) / 1e6,
    };
    row.docsMonthly300 = row.docsUsdMean == null ? null : row.docsUsdMean * 300 * 30;
    row.neuronsPerDay300 = row.neuronsMean == null ? null : row.neuronsMean * 300;
    row.freeCallsPerDay = row.neuronsMean ? FREE_NEURONS_PER_DAY / row.neuronsMean : null;
    // monthly bill if the free 10k neurons/day is used first ($0.011 per 1k neurons)
    row.monthlyAfterFree = row.neuronsPerDay300 == null ? null : Math.max(0, row.neuronsPerDay300 - FREE_NEURONS_PER_DAY) * 30 * 0.011 / 1000;
    costRows.push(row);
    summary.models[m] = { cost: row };
  }
  const totalUsd = costRows.reduce((a, r) => a + r.usdTotal, 0);

  // ---- key vs models
  const keyCore = keyFile.frames.filter((k) => k.set !== "ext");
  const keyRowsOf = (set) => (m, filterFn = () => true) =>
    set
      .filter((k) => !FAMILY[k.cam] || filterFn(k))
      .map((k) => ({ k, call: byKey[`${m}|${k.frameId}`] }))
      .filter((x) => x.call);
  const refFromKey = (k) => ({
    seaweed: k.seaweed?.level ?? null,
    covPct: k.seaweed?.pct ?? null,
    crowd: k.crowd?.level ?? null,
    crowdPct: k.crowd?.pct ?? null,
    people: k.crowd?.people ?? null,
    water: k.water?.word && k.water.word !== "unknown" ? k.water.word : null,
    waterPct: k.water?.pct ?? null,
  });

  const groups = [["All beach cams", (k) => k.cam !== UW_CAM], ...FAMILIES.filter((f) => f !== "Spinner underwater").map((fam) => [fam, (k) => FAMILY[k.cam] === fam])];
  const buildKeyTables = (set) => {
    const keyRows = keyRowsOf(set);
    const keyTables = {};
    for (const m of MODELS_ALL) {
    keyTables[m] = {};
    for (const [name, fn] of groups) {
      const rows = keyRows(m, fn)
        .filter((x) => !x.k.unreadable)
        .map((x) => ({ model: deriveClef(x.call.answers, false), ref: refFromKey(x.k) }))
        .filter((r) => r.model);
      keyTables[m][name] = fieldMetrics(rows);
      keyTables[m][name].nFrames = rows.length;
    }
    // water-unknown and unreadable agreement (all beach key frames incl. dark)
    const all = keyRows(m, (k) => k.cam !== UW_CAM).map((x) => ({ d: deriveClef(x.call.answers, false), k: x.k })).filter((x) => x.d);
    keyTables[m].unknown = unknownAgree(all.map((x) => ({ refUnknown: x.k.unreadable ? true : x.k.water?.word === "unknown", modelUnknown: x.d.waterUnknown })));
    const un = all.map((x) => ({ ref: !!x.k.unreadable, p: x.d.unreadableP }));
    keyTables[m].unreadable = {
      n: un.length,
      refYes: un.filter((u) => u.ref).length,
      tp: un.filter((u) => u.ref && u.p >= 0.5).length,
      fp: un.filter((u) => !u.ref && u.p >= 0.5).length,
      fn: un.filter((u) => u.ref && u.p < 0.5).length,
    };
    // Spinner
    const uwRows = keyRows(m, (k) => k.cam === UW_CAM).map((x) => ({ d: deriveClef(x.call.answers, true), k: x.k })).filter((x) => x.d);
    const uwUse = uwRows.filter((x) => !x.k.unreadable && x.k.uw?.level);
    keyTables[m].uw = {
      n: uwUse.length,
      level: ord(uwUse.map((x) => ({ a: x.d.uwLevel, b: x.k.uw.level })), UWC),
      pct: mae(uwUse.map((x) => ({ a: x.d.uwPct, b: x.k.uw.pct }))),
      unreadable: {
        n: uwRows.length,
        refYes: uwRows.filter((x) => x.k.unreadable).length,
        tp: uwRows.filter((x) => x.k.unreadable && x.d.unreadableP >= 0.5).length,
        fp: uwRows.filter((x) => !x.k.unreadable && x.d.unreadableP >= 0.5).length,
        fn: uwRows.filter((x) => x.k.unreadable && x.d.unreadableP < 0.5).length,
      },
    };
    }
    return keyTables;
  };
  const keyTables = buildKeyTables(keyCore);
  const keyTablesAll = buildKeyTables(keyFile.frames);
  summary.keyTables = keyTables;
  summary.keyTablesAll = keyTablesAll;

  // ---- production reads (by provider) vs key and vs Clef
  const provGroups = {
    "Gemini (2.5 flash + flash-lite)": (x) => x.provider === "gemini",
    "Groq Qwen (fallback)": (x) => x.provider === "groq",
    "All providers": () => true,
  };
  const prodReadToRef = (r) => ({ ...r, water: r.water && WATER.includes(r.water) ? r.water : null });
  const gemVsKey = {};
  const clefVsGem = {};
  const clefOnGemOverlap = {};
  for (const [pname, pfn] of Object.entries(provGroups)) {
    const ms = matches.filter(pfn).filter((x) => frameById[x.frameId]);
    const beach = ms.filter((x) => frameById[x.frameId].cam_id !== UW_CAM);
    // production read vs answer key (only on frames in the key and readable)
    const onKey = beach.filter((x) => keyById[x.frameId] && !keyById[x.frameId].unreadable);
    gemVsKey[pname] = { nMatchedAll: beach.length, frames: onKey.length, ...fieldMetrics(onKey.map((x) => ({ model: prodReadToRef(x.read), ref: refFromKey(keyById[x.frameId]) }))) };
    // production read: how often water null on key-unknown frames
    const keyAll = beach.filter((x) => keyById[x.frameId]);
    gemVsKey[pname].unknown = unknownAgree(keyAll.map((x) => ({ refUnknown: keyById[x.frameId].unreadable ? true : keyById[x.frameId].water?.word === "unknown", modelUnknown: x.read.water == null })));
    clefVsGem[pname] = {};
    clefOnGemOverlap[pname] = {};
    for (const m of MODELS_ALL) {
      const pairs = beach
        .map((x) => ({ x, call: byKey[`${m}|${x.frameId}`] }))
        .filter((y) => y.call)
        .map((y) => ({ x: y.x, d: deriveClef(y.call.answers, false) }))
        .filter((y) => y.d);
      clefVsGem[pname][m] = fieldMetrics(pairs.map((y) => ({ model: y.d, ref: prodReadToRef(y.x.read) })));
      clefVsGem[pname][m].nFrames = pairs.length;
      clefVsGem[pname][m].unknown = unknownAgree(pairs.map((y) => ({ refUnknown: y.x.read.water == null, modelUnknown: y.d.waterUnknown })));
      const both = pairs.filter((y) => keyById[y.x.frameId] && !keyById[y.x.frameId].unreadable);
      clefOnGemOverlap[pname][m] = fieldMetrics(both.map((y) => ({ model: y.d, ref: refFromKey(keyById[y.x.frameId]) })));
      clefOnGemOverlap[pname][m].nFrames = both.length;
    }
  }
  summary.gemVsKey = gemVsKey;
  summary.clefVsGem = clefVsGem;
  summary.clefOnGemOverlap = clefOnGemOverlap;

  // ---- worst disagreements: clef (27B) vs key
  const dis = [];
  for (const k of keyFile.frames) {  // all labelled frames
    if (k.cam === UW_CAM || k.unreadable) continue;
    const call = byKey[`clef|${k.frameId}`];
    if (!call) continue;
    const d = deriveClef(call.answers, false);
    if (!d) continue;
    const ref = refFromKey(k);
    const rank = (a, v) => (v == null ? null : a.indexOf(v));
    const dSw = ref.seaweed && d.seaweed ? Math.abs(rank(SEAWEED, d.seaweed) - rank(SEAWEED, ref.seaweed)) / 3 : 0;
    const dCr = ref.crowd && d.crowd ? Math.abs(rank(CROWD, d.crowd) - rank(CROWD, ref.crowd)) / 4 : 0;
    const dWa = ref.water && d.water ? Math.abs(rank(WATER, d.water) - rank(WATER, ref.water)) / 3 : ref.water ? 0.5 : 0;
    const dPp = ref.people != null && d.people != null ? Math.min(1, Math.abs(d.people - ref.people) / Math.max(10, ref.people)) : 0;
    const dWp = ref.waterPct != null && d.waterPct != null ? Math.abs(d.waterPct - ref.waterPct) / 50 : 0;
    const score = dSw + dCr + dWa + dPp * 0.7 + dWp * 0.5 + (ref.covPct != null && d.covPct != null ? Math.abs(d.covPct - ref.covPct) / 60 : 0);
    const gem = matches.find((x) => x.frameId === k.frameId && x.provider === "gemini") || matches.find((x) => x.frameId === k.frameId);
    dis.push({ k, d, score, gem });
  }
  dis.sort((a, b) => b.score - a.score);
  summary.worst = dis.slice(0, 8).map((x) => ({ frameId: x.k.frameId, score: round(x.score, 2) }));

  // ---- write
  fs.writeFileSync(path.join(OUT, "summary.json"), JSON.stringify(summary, null, 1));
  const L = [];
  const push = (...a) => L.push(...a);
  const tbl = (head, rows) => {
    push("| " + head.join(" | ") + " |", "| " + head.map(() => "---").join(" | ") + " |");
    for (const r of rows) push("| " + r.join(" | ") + " |");
    push("");
  };
  push("<!-- AUTO:START (rewritten by scripts/clef_vision_backtest.mjs --report) -->", "");
  push("## Run facts", "");
  tbl(
    ["item", "value"],
    [
      ["Frames archived (state=ready)", frs.length],
      ["Answer-key frames", `${keyFile.frames.filter((k) => k.set !== "ext").length} core + ${keyFile.frames.filter((k) => k.set === "ext").length} extension`],
      ["cam_reads rows since " + READS_FROM, `${stats.reads}`],
      ["Matched to a frame by frameAt", stats.matchedByFrameAt],
      ["Matched by time (within 10 min)", stats.matchedByTime],
      ["Unmatched", stats.unmatched],
      ["Providers in matched reads", [...new Set(matches.map((m) => `${m.provider}/${m.model}`))].join(", ")],
      ["Workers AI spend (all calls, estimated)", "$" + totalUsd.toFixed(4)],
    ]
  );
  push("## Cost, speed and parse rate", "");
  tbl(
    ["model", "calls", "answered", "API failures", "malformed", "fail rate", "latency p50", "latency p95", "input tokens / call", "$ / call (spend-cap price)", "total $ (spend-cap price)", "$ / call (docs price)", "$ / month at 300 reads/day (docs price)"],
    costRows.map((r) => [r.model, r.calls, r.answered, r.apiFailures, r.malformed, f1(r.failRate), (r.latP50 ?? "-") + " ms", (r.latP95 ?? "-") + " ms", r.tokMean == null ? "-" : Math.round(r.tokMean), r.usdMean == null ? "-" : "$" + r.usdMean.toFixed(5), "$" + r.usdTotal.toFixed(4), r.docsUsdMean == null ? "-" : "$" + r.docsUsdMean.toFixed(5), r.docsMonthly300 == null ? "-" : "$" + r.docsMonthly300.toFixed(2)])
  );
  tbl(
    ["model", "neurons / call", "neurons / day at 300 reads", "free neurons / day", "calls / day the free allowance covers", "$ / month at 300 reads/day after the free allowance"],
    costRows.map((r) => [r.model, r.neuronsMean == null ? "-" : r.neuronsMean.toFixed(1), r.neuronsPerDay300 == null ? "-" : Math.round(r.neuronsPerDay300), FREE_NEURONS_PER_DAY, r.freeCallsPerDay == null ? "-" : Math.round(r.freeCallsPerDay), r.monthlyAfterFree == null ? "-" : "$" + r.monthlyAfterFree.toFixed(2)])
  );
  push("The spend cap used the Dumpster Brain price table, which has clef-flash at $0.09 per M tokens. Cloudflare's pricing page says $0.038, so the real flash cost is lower than the cached figure. Neuron figures and the 10,000 neurons per day allowance (Workers Free and Paid) come from the same page. The allowance is shared with every other Workers AI call on the account.", "");
  push("Latency is over the REST API from a Mac. Inside a Worker it will differ. \"Malformed\" means the reply lacked a field we need.", "");

  const nCore = keyFile.frames.filter((k) => k.set !== "ext").length;
  const nAll = keyFile.frames.length;
  const keyBlock = (kt, label) => {
    push(label, "");
    for (const m of MODELS_ALL) {
      push(`**${m}**`, "");
      tbl(
        ["group", "frames", "seaweed (exact / within 1)", "coverage % MAE", "crowd (exact / within 1)", "crowd % MAE", "people MAE", "people MAE (key >= 5)", "water (exact / within 1)", "water % MAE"],
        Object.entries(kt[m])
          .filter(([, v]) => v && v.seaweed)
          .map(([name, v]) => [name, v.nFrames, fmtOrd(v.seaweed), fmtMae(v.cov), fmtOrd(v.crowd), fmtMae(v.crowdPct), fmtMae(v.people), fmtMae(v.people5), fmtOrd(v.water), fmtMae(v.waterPct)])
      );
    }
    tbl(
      ["model", "dark/unreadable: key yes", "caught (p>=0.5)", "false alarms", "missed", "water unknown or dark: key yes", "model said unknown too", "model said unknown wrongly"],
      MODELS_ALL.map((m) => {
        const u = kt[m].unreadable;
        const w = kt[m].unknown;
        return [m, u.refYes, u.tp, u.fp, u.fn, w.tp + w.fn, w.tp, w.fp];
      })
    );
  };
  push("## Clef vs the answer key", "", "Cells show exact / within one bucket for words, and mean absolute error for numbers. n is the frames scored. Frames the key calls unreadable are left out of the field cells; the last table of each block scores them.", "");
  keyBlock(keyTables, `### Core key: the ${nCore} stratified frames`);
  keyBlock(keyTablesAll, `### All ${nAll} labelled frames (core plus extension)`);
  push("### Spinner (underwater) vs the answer key (all labelled Spinner frames)", "");
  tbl(
    ["model", "frames scored", "clarity word (exact / within 1)", "visibility % MAE", "dark: key yes", "dark caught", "false dark", "dark missed"],
    MODELS_ALL.map((m) => {
      const u = keyTablesAll[m].uw;
      return [m, u.n, fmtOrd(u.level), fmtMae(u.pct), u.unreadable.refYes, u.unreadable.tp, u.unreadable.fp, u.unreadable.fn];
    })
  );

  {
    // On frames the key calls dark/unreadable (beach cams), how often does each reader still give a confident answer?
    const darkIds = keyFile.frames.filter((k) => k.unreadable && k.cam !== UW_CAM).map((k) => k.frameId);
    const rowsD = [];
    for (const [pname, pfn] of Object.entries(provGroups)) {
      const ms = matches.filter(pfn).filter((x) => darkIds.includes(x.frameId));
      if (!ms.length) continue;
      rowsD.push([pname, ms.length, ms.filter((x) => x.read.water && WATER.includes(x.read.water)).length, ms.filter((x) => ["moderate", "busy", "packed"].includes(x.read.crowd)).length]);
    }
    for (const m of MODELS_ALL) {
      const ds = darkIds.map((id) => byKey[`${m}|${id}`]).filter(Boolean).map((c) => deriveClef(c.answers, false)).filter(Boolean);
      rowsD.push([m, ds.length, ds.filter((d) => d.water).length, ds.filter((d) => ["moderate", "busy", "packed"].includes(d.crowd)).length]);
    }
    push("## Dark frames: does the reader still invent an answer?", "", "Frames the key calls dark, blank or in silhouette (beach cams only). A good reader gives no water grade and does not call the beach busy.", "");
    tbl(["reader", "dark frames read", "gave a water grade anyway", "called crowd moderate or higher"], rowsD);
  }
  push("## Production readers vs the answer key", "", "Only labelled frames (core plus extension) that have a matched cam_reads row. Frames the key calls unreadable are left out.", "");
  tbl(
    ["reader", "matched reads (all)", "scored vs key", "seaweed", "coverage % MAE", "crowd", "crowd % MAE", "people MAE", "people MAE (key >= 5)", "water", "water % MAE"],
    Object.entries(gemVsKey).map(([p, v]) => [p, v.nMatchedAll, v.frames, fmtOrd(v.seaweed), fmtMae(v.cov), fmtOrd(v.crowd), fmtMae(v.crowdPct), fmtMae(v.people), fmtMae(v.people5), fmtOrd(v.water), fmtMae(v.waterPct)])
  );
  push("Same frames, Clef against the key (apples to apples with the table above):", "");
  const rowsOv = [];
  for (const [p, byM] of Object.entries(clefOnGemOverlap))
    for (const m of MODELS_ALL) {
      const v = byM[m];
      rowsOv.push([`${m} (frames where ${p} also read)`, v.nFrames, fmtOrd(v.seaweed), fmtMae(v.cov), fmtOrd(v.crowd), fmtMae(v.crowdPct), fmtMae(v.people), fmtMae(v.people5), fmtOrd(v.water), fmtMae(v.waterPct)]);
    }
  tbl(["Clef on the same frames", "frames", "seaweed", "coverage % MAE", "crowd", "crowd % MAE", "people MAE", "people MAE (key >= 5)", "water", "water % MAE"], rowsOv);

  push("## Clef vs production readers (agreement, not truth)", "", "Reference = the production reading. Same cells as above.", "");
  const rowsG = [];
  for (const [p, byM] of Object.entries(clefVsGem))
    for (const m of MODELS_ALL) {
      const v = byM[m];
      rowsG.push([`${m} vs ${p}`, v.nFrames, fmtOrd(v.seaweed), fmtMae(v.cov), fmtOrd(v.crowd), fmtMae(v.crowdPct), fmtMae(v.people), fmtMae(v.people5), fmtOrd(v.water), fmtMae(v.waterPct), `${v.unknown.tp + v.unknown.fp}/${v.unknown.tp + v.unknown.fn} (agree ${f1(v.unknown.acc)})`]);
    }
  tbl(["pair", "frames", "seaweed", "coverage % MAE", "crowd", "crowd % MAE", "people MAE", "people MAE (key >= 5)", "water", "water % MAE", "water unknown: Clef/prod"], rowsG);

  push("## Eight worst disagreements (clef 27B vs the answer key)", "");
  tbl(
    ["frame", "key", "production read", "clef 27B", "why (key note)"],
    dis.slice(0, 8).map((x) => {
      const k = x.k;
      const kk = `sw ${k.seaweed?.level ?? "-"}/${k.seaweed?.pct ?? "-"}%, crowd ${k.crowd?.level ?? "-"}/${k.crowd?.people ?? "-"} ppl, water ${k.water?.word ?? "-"}/${k.water?.pct ?? "-"}`;
      const g = x.gem ? x.gem.read : null;
      const gg = g ? `${x.gem.provider}: sw ${g.seaweed}/${g.covPct}%, crowd ${g.crowd}/${g.people} ppl, water ${g.water ?? "null"}/${g.waterPct ?? "-"}` : "no read";
      const d = x.d;
      const cc = `sw ${d.seaweed}/${d.covPct}%, crowd ${d.crowd}/${d.people} ppl, water ${d.water ?? "unknown"}/${d.waterPct}`;
      return [k.frameId, kk, gg, cc, (k.reason || "").replaceAll("|", "/")];
    })
  );
  // per-frame table, so every number above can be traced to a frame
  {
    const hdr = ["frameId", "set", "family", "unreadable_key", "key_sw", "key_cov", "key_crowd", "key_people", "key_water", "key_waterPct", "key_uw", "key_uwPct"];
    for (const m of ["clef", "clef-flash"]) hdr.push(...["sw", "cov", "crowd", "crowdPct", "people", "water", "waterPct", "unreadableP", "uw", "uwPct"].map((x) => `${m}_${x}`));
    hdr.push("prod_provider", "prod_sw", "prod_cov", "prod_crowd", "prod_people", "prod_water", "prod_waterPct");
    const rowsCsv = [hdr.join(",")];
    for (const k of keyFile.frames) {
      const r = [k.frameId, k.set || "core", k.family, k.unreadable ? 1 : 0, k.seaweed?.level ?? "", k.seaweed?.pct ?? "", k.crowd?.level ?? "", k.crowd?.people ?? "", k.water?.word ?? "", k.water?.pct ?? "", k.uw?.level ?? "", k.uw?.pct ?? ""];
      for (const m of ["clef", "clef-flash"]) {
        const c = byKey[`${m}|${k.frameId}`];
        const d = c ? deriveClef(c.answers, k.cam === UW_CAM) : null;
        if (!d) r.push(...Array(10).fill(""));
        else r.push(d.seaweed ?? "", d.covPct ?? "", d.crowd ?? "", d.crowdPct ?? "", d.people ?? "", d.waterUnknown ? "unknown" : d.water ?? "", d.waterPct ?? "", d.unreadableP == null ? "" : d.unreadableP.toFixed(2), d.uwLevel ?? "", d.uwPct ?? "");
      }
      const mm = matches.find((x) => x.frameId === k.frameId);
      r.push(mm ? mm.provider : "", mm?.read.seaweed ?? "", mm?.read.covPct ?? "", mm?.read.crowd ?? "", mm?.read.people ?? "", mm ? mm.read.water ?? "null" : "", mm?.read.waterPct ?? "");
      rowsCsv.push(r.join(","));
    }
    fs.writeFileSync(path.join(OUT, "per-frame.csv"), rowsCsv.join("\n") + "\n");
  }
  push("<!-- AUTO:END -->");

  // keep hand-written text above the AUTO block
  const rp = path.join(OUT, "REPORT.md");
  const prev = fs.existsSync(rp) ? fs.readFileSync(rp, "utf8") : "# Clef as a Beach Day cam reader - offline backtest\n\n";
  const i = prev.indexOf("<!-- AUTO:START");
  const head = i >= 0 ? prev.slice(0, i) : prev + "\n";
  const j = prev.indexOf("<!-- AUTO:END -->");
  const tail = i >= 0 && j > i ? prev.slice(j + "<!-- AUTO:END -->".length) : "";
  fs.writeFileSync(rp, head + L.join("\n") + tail);
  log(`report written. Workers AI spend $${totalUsd.toFixed(4)}. Fail rates: ${costRows.map((r) => `${r.model} ${f1(r.failRate)}`).join(", ")}`);
}

// ------------------------------------------------------------------- main ----
if (args.fetch) await doFetch();
else if (args.sample) doSample();
else if (args.run) await doRun();
else if (args.report) doReport();
else log("usage: --fetch | --sample | --run | --report   (see header)");
