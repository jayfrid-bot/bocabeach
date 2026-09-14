/**
 * uw-frame — multi-cam frame courier + Deerfield lifeguard-flag reader.
 *
 * Started as a single-cam courier for Deerfield Beach's "Spinner the Sea
 * Cam" underwater YouTube livestream (video id SHfAtWHr9Ks), grabbed for
 * water-clarity calibration. YouTube blocks yt-dlp from GitHub datacenter
 * IPs (every player client), and the live-thumbnail trick fails because
 * custom cover art overrides it — so we open the stream in a real headless
 * Chrome (Cloudflare Browser Rendering), wait for the <video> to be actually
 * playing, and screenshot the video region.
 *
 * It now does the same for Deerfield Beach's surface cams (crowd/sand, surf,
 * pier) — those exist ONLY as YouTube live streams on the City's channel,
 * there is no still-image feed either — plus a fifth job: reading which
 * lifeguard flag(s) are currently flying from the City's public ArcGIS
 * "Beach Conditions" dashboard. All five are driven from ONE cron handler so
 * they can share a single browser launch (see BROWSER-RENDERING BUDGET
 * below). The camera list itself lives in src/lib/schedule.ts (CAMERA_
 * REGISTRY) — that file is the single source of truth for what gets grabbed
 * and how often; this file is the mechanics of grabbing it.
 *
 * WHY AN IFRAME ON OUR OWN ORIGIN (not the bare embed URL):
 *   Loading https://www.youtube.com/embed/<id> as a TOP-LEVEL document fails
 *   with "Error 153 — Video player configuration error": YouTube's player
 *   only runs correctly when embedded in an <iframe> under a real http(s)
 *   origin (that is how the city's own page embeds it). So the worker serves
 *   its own /host page containing the iframe (now parameterised by ?v=
 *   <videoId> so the same page works for every camera), navigates headless
 *   Chrome to that page (real https origin = this worker), and drives the
 *   cross-origin YouTube frame via puppeteer's frame API (automation is not
 *   bound by same-origin policy).
 *
 * ENDPOINTS
 *   GET /frame            -> image/jpeg, Spinner cam (unchanged legacy shape)
 *   GET /meta              -> JSON, Spinner cam (unchanged legacy shape)
 *   GET /frame?cam=<id>    -> image/jpeg for any registered camera
 *   GET /meta?cam=<id>     -> JSON {id, videoId, grabbedAtUtc, ms, ok, error?}
 *   GET /cams               -> JSON: the registry + each cam's last meta
 *   GET /flags?slug=deerfield-beach
 *                           -> JSON {flags, observedAtUtc, ok, error?, rawText?}
 *   GET /grab               -> run every due grab + the flag read on demand
 *                              (proves the pipeline via curl). Same code path
 *                              as the cron handler.
 *   GET /host?v=<videoId>  -> internal: the iframe host page the headless
 *                              browser loads. Only accepts a videoId that is
 *                              actually in CAMERA_REGISTRY.
 *   GET /                   -> tiny help text.
 *
 * SCHEDULE: crons "0 10-23 * * *" + "0 0 * * *" — top of each hour 10:00-
 * 24:00 UTC (~6 AM-8 PM ET), 15 ticks/day. Which cameras (and whether the
 * flag read) run at a given tick is decided inside the handler by
 * src/lib/schedule.ts:
 *   - deerfield-spinner-uw: every tick (unchanged, 15 grabs/day)
 *   - the 3 surface cams:   only on a "surface hour" (UTC hour % 3 === 1,
 *                            i.e. 10/13/16/19/22 UTC) AND only while it's
 *                            daylight in America/New_York — 5 ticks/day
 *   - lifeguard flags:      once per tick, while it's daylight in
 *                            America/New_York — up to 15 reads/day
 *
 * BROWSER-RENDERING BUDGET (free tier ~10 browser-minutes/day, we're
 * targeting comfortably under ~20 min/day so there's headroom):
 *   Using each stage's own worst-case timeout as the per-item estimate
 *   (the same convention the original single-cam version of this file used
 *   — actual successful grabs are usually much faster than the timeout):
 *     - underwater, 15 ticks/day x 1 grab x ~25s  = 375s  (~6.25 min/day)
 *     - surface cams, 5 ticks/day x 3 grabs x ~25s = 375s  (~6.25 min/day)
 *     - flags, 15 ticks/day x 1 read x ~25s        = 375s  (~6.25 min/day)
 *                                                    -----
 *                                                   1125s  (~18.75 min/day)
 *   The spec this worker was built from asked for the surface cams every 2
 *   hours (8 ticks/day instead of 5). Redoing the sum with 8 ticks/day gives
 *   375 + 600 + 375 = 1350s (~22.5 min/day), OVER the ~20 min/day target —
 *   so the surface-cam cadence was widened to every 3 hours instead
 *   (src/lib/schedule.ts: isSurfaceCamHour, cadence "3h-daylight"), which is
 *   what the 18.75 min/day sum above reflects. If the underwater or flags
 *   cadence ever needs to grow, re-run this sum first.
 *   A single cron tick launches ONE browser and reuses ONE page across every
 *   cam due that tick (nav embed -> wait for playback -> screenshot ->
 *   next), so a multi-cam tick costs one browser session, not several. A
 *   tick aborts any remaining cams once its running total passes
 *   TICK_BUDGET_MS (~90s) so one slow tick can't cascade into the next
 *   hour's budget; the flag read has its own separate ~25s cap
 *   (FLAGS_BUDGET_MS) and always gets attempted even if cam grabs used the
 *   full 90s, since it's cheap and independent of them.
 *
 * QUALITY GUARD: a screenshot smaller than MIN_GOOD_BYTES (likely a
 * black/blank frame) is REJECTED and never overwrites a previously stored
 * good frame for that camera. Public read is fine (they're public cam
 * frames and a public flag dashboard); no auth on the read paths.
 */
import puppeteer, { type Browser, type Page } from "@cloudflare/puppeteer";
import {
  CAMERA_REGISTRY,
  camsDueAtTick,
  findCamera,
  isDaylightEastern,
  type CameraId,
  type CameraSpec,
} from "./lib/schedule";
import { parseVisibleFlags, summarizeVisibleText, type FlagDomEntry, type FlagName } from "./lib/flags";

export interface Env {
  BROWSER: Fetcher; // Browser Rendering binding
  UW_FRAME: KVNamespace;
}

// This worker's own origin — the iframe host page must be served from a real
// https origin so the YouTube embed inside it gets a valid referrer (fixes
// Error 153).
const SELF_ORIGIN = "https://uw-frame.entwined-app.workers.dev";

// --- Legacy Spinner-cam KV keys — DO NOT RENAME. The Python vision job (and
// possibly other readers) reads these directly today; they keep their exact
// shape and are written in addition to the new per-cam keys below. ---
const LEGACY_KEY_FRAME = "frame:latest"; // base64 JPEG bytes
const LEGACY_KEY_META = "frame:meta"; // JSON {grabbedAtUtc, bytes, width, height}
const LEGACY_CAM_ID: CameraId = "deerfield-spinner-uw";

interface LegacyMeta {
  grabbedAtUtc: string;
  bytes: number;
  width: number;
  height: number;
}

// --- New per-cam KV keys: frame:<id> / meta:<id> ---
function frameKey(id: string): string {
  return `frame:${id}`;
}
function metaKey(id: string): string {
  return `meta:${id}`;
}

interface CamMeta {
  id: string;
  videoId: string;
  grabbedAtUtc: string;
  ms: number;
  ok: boolean;
  error?: string;
}

// --- Lifeguard flags KV key ---
const FLAGS_SLUG = "deerfield-beach";
function flagsKey(slug: string): string {
  return `flags:${slug}`;
}
const ARCGIS_DASHBOARD_URL =
  "https://www.arcgis.com/apps/dashboards/02f2e5d84cfd43be90a0bb568eb68785";

interface FlagsResult {
  flags: FlagName[];
  observedAtUtc: string;
  ok: boolean;
  error?: string;
  rawText?: string;
}

const MIN_GOOD_BYTES = 15_000; // reject suspiciously-small (likely black) frames
const PLAY_TIMEOUT_MS = 25_000; // hard cap on waiting for a real playing frame per cam
const TICK_BUDGET_MS = 90_000; // whole-tick cap across every cam grab, see header
const FLAGS_BUDGET_MS = 25_000; // separate cap for the lifeguard-flag read
const VIEWPORT = { width: 1280, height: 720 };

function hostHtml(videoId: string): string {
  const embedUrl = `https://www.youtube.com/embed/${videoId}?autoplay=1&mute=1&playsinline=1&rel=0`;
  return (
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<style>html,body{margin:0;padding:0;background:#000;overflow:hidden}` +
    `iframe{border:0;display:block}</style></head><body>` +
    `<iframe id="yt" width="${VIEWPORT.width}" height="${VIEWPORT.height}" ` +
    `allow="autoplay; encrypted-media" allowfullscreen ` +
    `src="${embedUrl}"></iframe></body></html>`
  );
}

function nowUtc(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function b64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

async function readJson<T>(env: Env, key: string): Promise<T | null> {
  const raw = await env.UW_FRAME.get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * Grab one camera's frame using an already-open page (reused across cams in
 * the same tick). Returns a result object; NEVER throws — the caller treats
 * a bad result as a soft skip so the previous good frame for that cam stands.
 */
async function grabOneCam(
  page: Page,
  cam: CameraSpec
): Promise<{ ok: boolean; reason?: string; shot?: Uint8Array; ms: number }> {
  const start = Date.now();
  try {
    // Load OUR host page (real origin); the YouTube embed lives in its
    // iframe, parameterised per-camera by ?v=.
    await page.goto(`${SELF_ORIGIN}/host?v=${cam.videoId}`, {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });

    const iframeEl = await page.waitForSelector("iframe#yt", { timeout: 8_000 });
    if (!iframeEl) return { ok: false, reason: "iframe not found", ms: Date.now() - start };
    const frame = await iframeEl.contentFrame();
    if (!frame) return { ok: false, reason: "no content frame", ms: Date.now() - start };

    // Nudge autoplay (muted autoplay is allowed headless).
    try {
      await frame.evaluate(() => {
        const v = document.querySelector("video") as HTMLVideoElement | null;
        if (v) {
          v.muted = true;
          void v.play().catch(() => {});
        }
        const btn = document.querySelector(
          ".ytp-large-play-button, button.ytp-play-button"
        ) as HTMLElement | null;
        btn?.click();
      });
    } catch {
      /* best-effort */
    }

    // Poll the video INSIDE the iframe until it is decoding a real frame.
    let playing = false;
    while (Date.now() - start < PLAY_TIMEOUT_MS) {
      const state = await frame.evaluate(() => {
        const v = document.querySelector("video") as HTMLVideoElement | null;
        const err = document.querySelector(".ytp-error");
        return {
          ready: v ? v.readyState : 0,
          t: v ? v.currentTime : 0,
          unavailable: !!err,
        };
      });
      if (state.unavailable) {
        return {
          ok: false,
          reason: "video unavailable (embed error overlay)",
          ms: Date.now() - start,
        };
      }
      if (state.ready >= 2 && state.t > 0) {
        playing = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 700));
    }
    if (!playing) {
      return { ok: false, reason: "timed out waiting for a playing frame", ms: Date.now() - start };
    }

    // Clean up the frame so it's mostly water/beach — matching the old
    // ffmpeg courier. Two layers, both cosmetic (a failure here never fails
    // the grab): (1) inject CSS to force-hide YouTube's control chrome +
    // cursor, then (2) leave the player untouched for ~3.5s so YouTube's own
    // inactivity timer fades whatever chrome the CSS didn't catch.
    try {
      await frame.evaluate(() => {
        const s = document.createElement("style");
        s.textContent =
          ".ytp-chrome-top,.ytp-chrome-bottom,.ytp-gradient-top," +
          ".ytp-gradient-bottom,.ytp-large-play-button,.ytp-spinner," +
          ".ytp-pause-overlay,.ytp-ce-element,.ytp-cued-thumbnail-overlay," +
          ".annotation,.iv-branding,.ytp-watermark,.ytp-title,.ytp-progress-bar-container," +
          ".ytp-live,.ytp-button{opacity:0!important;display:none!important;visibility:hidden!important}" +
          "*{cursor:none!important}";
        (document.head || document.documentElement).appendChild(s);
      });
    } catch {
      /* cosmetic only */
    }
    await new Promise((r) => setTimeout(r, 3500));

    // Screenshot the video region. Prefer the <video> element inside the
    // frame; fall back to the iframe element.
    let shot: Uint8Array | null = null;
    try {
      const vh = await frame.$("video");
      if (vh) shot = (await vh.screenshot({ type: "jpeg", quality: 80 })) as Uint8Array;
    } catch {
      /* fall through */
    }
    if (!shot) {
      shot = (await iframeEl.screenshot({ type: "jpeg", quality: 80 })) as Uint8Array;
    }

    const isJpeg = shot.length > 2 && shot[0] === 0xff && shot[1] === 0xd8;
    if (!isJpeg) {
      return { ok: false, reason: `not a JPEG (${shot.length} bytes)`, ms: Date.now() - start };
    }
    if (shot.length < MIN_GOOD_BYTES) {
      return {
        ok: false,
        reason: `frame too small (${shot.length} < ${MIN_GOOD_BYTES}) — likely blank`,
        ms: Date.now() - start,
      };
    }

    return { ok: true, shot, ms: Date.now() - start };
  } catch (e) {
    return { ok: false, reason: `grab error: ${(e as Error).message}`, ms: Date.now() - start };
  }
}

async function storeCamResult(
  env: Env,
  cam: CameraSpec,
  result: { ok: boolean; reason?: string; shot?: Uint8Array; ms: number }
): Promise<void> {
  const grabbedAtUtc = nowUtc();
  const meta: CamMeta = {
    id: cam.id,
    videoId: cam.videoId,
    grabbedAtUtc,
    ms: result.ms,
    ok: result.ok,
    ...(result.reason ? { error: result.reason } : {}),
  };

  if (result.ok && result.shot) {
    await env.UW_FRAME.put(frameKey(cam.id), bytesToB64(result.shot));
  }
  await env.UW_FRAME.put(metaKey(cam.id), JSON.stringify(meta));

  // Keep writing the legacy Spinner-cam keys EXACTLY as the original single-
  // cam version of this worker did, so the Python vision job (and any other
  // reader) keeps working unchanged.
  if (cam.id === LEGACY_CAM_ID && result.ok && result.shot) {
    const legacyMeta: LegacyMeta = {
      grabbedAtUtc,
      bytes: result.shot.length,
      width: VIEWPORT.width,
      height: VIEWPORT.height,
    };
    await env.UW_FRAME.put(LEGACY_KEY_FRAME, bytesToB64(result.shot));
    await env.UW_FRAME.put(LEGACY_KEY_META, JSON.stringify(legacyMeta));
  }
}

/**
 * Read which lifeguard flag(s) are visible on the City's public ArcGIS
 * "Beach Conditions" dashboard, using the SAME already-open browser (a new
 * page) as the cam grabs. Never throws — a failure is reported as
 * {ok:false, error} so the cron never dies on a dashboard change/outage.
 */
async function readLifeguardFlags(browser: Browser): Promise<FlagsResult> {
  const start = Date.now();
  const observedAtUtc = nowUtc();
  let page: Page | null = null;
  try {
    page = await browser.newPage();
    await page.setViewport(VIEWPORT);
    await page.goto(ARCGIS_DASHBOARD_URL, {
      waitUntil: "domcontentloaded",
      timeout: Math.min(15_000, FLAGS_BUDGET_MS),
    });

    // The dashboard is an ArcGIS Experience/Dashboard app: it renders its
    // widgets client-side after load. Give it a short, budget-aware moment
    // to finish toggling the flag blocks before we read them.
    const settleMs = Math.max(0, Math.min(4_000, FLAGS_BUDGET_MS - (Date.now() - start) - 2_000));
    await new Promise((r) => setTimeout(r, settleMs));

    // Walk the live DOM for anything that could plausibly be one of the five
    // flag blocks (by the color/"flag" words in its own text, or by the
    // ArcGIS documentId embedded in its id/class/src), and record whether
    // it's actually visible. This reduction to plain data is what makes the
    // matching logic (parseVisibleFlags) testable without a browser: the
    // browser-only part is just "find candidates + compute visibility".
    const entries = (await page.evaluate(() => {
      const KNOWN_IDS = ["15330", "15332", "15329", "15326", "15327"];
      const COLOR_WORD = /(double[_\s-]*red|single[_\s-]*red|red|yellow|green|purple)/i;
      const out: { text: string; alt: string; src: string; visible: boolean }[] = [];
      const all = Array.from(document.querySelectorAll<HTMLElement>("*"));
      for (const el of all) {
        const idAttr = el.id || "";
        const cls = typeof el.className === "string" ? el.className : "";
        const isImg = el.tagName === "IMG";
        const alt = isImg ? (el as HTMLImageElement).alt || "" : "";
        const src = isImg ? (el as HTMLImageElement).src || "" : "";
        const ownText = el.childElementCount === 0 ? (el.textContent || "").trim() : "";
        const haystack = `${idAttr} ${cls} ${alt} ${src} ${ownText}`;
        const hasKnownId = KNOWN_IDS.some((id) => haystack.includes(id));
        const looksLikeFlag = COLOR_WORD.test(haystack) && /flag/i.test(haystack);
        if (!hasKnownId && !looksLikeFlag) continue;

        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        const visible =
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          Number(style.opacity || "1") > 0 &&
          rect.width > 0 &&
          rect.height > 0;

        out.push({ text: ownText.slice(0, 200), alt, src, visible });
      }
      return out;
    })) as FlagDomEntry[];

    const flags = parseVisibleFlags(entries);
    const rawText = summarizeVisibleText(entries);
    return { flags, observedAtUtc, ok: true, ...(rawText ? { rawText } : {}) };
  } catch (e) {
    return { flags: [], observedAtUtc, ok: false, error: `flags read error: ${(e as Error).message}` };
  } finally {
    if (page) {
      try {
        await page.close();
      } catch {
        /* ignore */
      }
    }
  }
}

interface TickSummary {
  tickAtUtc: string;
  cams: { id: string; ok: boolean; ms: number; reason?: string; skipped?: boolean }[];
  flags: { ok: boolean; ms: number; error?: string } | null;
}

/**
 * Run every cam due at this tick (sequentially, one shared browser + page)
 * plus the lifeguard-flag read if it's a daylight tick. Never throws.
 */
async function runTick(env: Env, tickDate: Date): Promise<TickSummary> {
  const due = camsDueAtTick(tickDate);
  const doFlags = isDaylightEastern(tickDate);
  const summary: TickSummary = { tickAtUtc: nowUtc(), cams: [], flags: null };

  let browser: Browser | null = null;
  try {
    browser = await puppeteer.launch(env.BROWSER);
    const page = await browser.newPage();
    await page.setViewport(VIEWPORT);

    const tickStart = Date.now();
    for (const cam of due) {
      if (Date.now() - tickStart > TICK_BUDGET_MS) {
        summary.cams.push({ id: cam.id, ok: false, ms: 0, reason: "tick budget exceeded", skipped: true });
        continue;
      }
      const result = await grabOneCam(page, cam);
      await storeCamResult(env, cam, result);
      summary.cams.push({ id: cam.id, ok: result.ok, ms: result.ms, reason: result.reason });
    }

    if (doFlags) {
      const flagsResult = await readLifeguardFlags(browser);
      await env.UW_FRAME.put(flagsKey(FLAGS_SLUG), JSON.stringify(flagsResult));
      summary.flags = {
        ok: flagsResult.ok,
        ms: Date.now() - tickStart,
        ...(flagsResult.error ? { error: flagsResult.error } : {}),
      };
    }
  } catch (e) {
    summary.cams.push({ id: "*", ok: false, ms: 0, reason: `tick error: ${(e as Error).message}` });
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {
        /* ignore */
      }
    }
  }

  return summary;
}

async function handleFrame(env: Env, camParam: string | null): Promise<Response> {
  if (!camParam) {
    // Legacy behaviour, unchanged: the Spinner cam via the legacy keys.
    const b64 = await env.UW_FRAME.get(LEGACY_KEY_FRAME);
    const meta = await readJson<LegacyMeta>(env, LEGACY_KEY_META);
    if (!b64 || !meta) return new Response("no frame yet", { status: 404 });
    return new Response(b64ToBytes(b64), {
      headers: {
        "Content-Type": "image/jpeg",
        "X-Grabbed-At": meta.grabbedAtUtc,
        "Cache-Control": "public, max-age=300",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }

  const cam = findCamera(camParam);
  if (!cam) {
    return Response.json({ ok: false, error: `unknown cam "${camParam}"` }, { status: 404 });
  }
  const b64 = await env.UW_FRAME.get(frameKey(cam.id));
  const meta = await readJson<CamMeta>(env, metaKey(cam.id));
  if (!b64 || !meta) return new Response("no frame yet", { status: 404 });
  return new Response(b64ToBytes(b64), {
    headers: {
      "Content-Type": "image/jpeg",
      "X-Grabbed-At": meta.grabbedAtUtc,
      "Cache-Control": "public, max-age=300",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

async function handleMeta(env: Env, camParam: string | null): Promise<Response> {
  if (!camParam) {
    const meta = await readJson<LegacyMeta>(env, LEGACY_KEY_META);
    return Response.json(meta ?? { grabbedAtUtc: null }, {
      headers: { "Access-Control-Allow-Origin": "*" },
    });
  }
  const cam = findCamera(camParam);
  if (!cam) {
    return Response.json({ ok: false, error: `unknown cam "${camParam}"` }, { status: 404 });
  }
  const meta = await readJson<CamMeta>(env, metaKey(cam.id));
  return Response.json(meta ?? { id: cam.id, videoId: cam.videoId, grabbedAtUtc: null, ok: false }, {
    headers: { "Access-Control-Allow-Origin": "*" },
  });
}

async function handleCams(env: Env): Promise<Response> {
  const cams = await Promise.all(
    CAMERA_REGISTRY.map(async (cam) => {
      const meta = await readJson<CamMeta>(env, metaKey(cam.id));
      return {
        id: cam.id,
        videoId: cam.videoId,
        label: cam.label,
        purpose: cam.purpose,
        cadence: cam.cadence,
        grabbedAtUtc: meta?.grabbedAtUtc ?? null,
        ok: meta?.ok ?? null,
      };
    })
  );
  return Response.json({ cams }, { headers: { "Access-Control-Allow-Origin": "*" } });
}

async function handleFlags(env: Env, slugParam: string | null): Promise<Response> {
  const slug = slugParam ?? FLAGS_SLUG;
  if (slug !== FLAGS_SLUG) {
    return Response.json({ ok: false, error: `unknown flags slug "${slug}"` }, { status: 404 });
  }
  const flags = await readJson<FlagsResult>(env, flagsKey(slug));
  return Response.json(flags ?? { flags: [], observedAtUtc: null, ok: false }, {
    headers: { "Access-Control-Allow-Origin": "*" },
  });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/host") {
      // Internal iframe host page loaded by the headless browser only.
      // Only ever serve a videoId that's actually in our registry.
      const v = url.searchParams.get("v");
      const known = v && CAMERA_REGISTRY.some((c) => c.videoId === v);
      const videoId = known ? (v as string) : CAMERA_REGISTRY[0].videoId;
      return new Response(hostHtml(videoId), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    if (path === "/frame") return handleFrame(env, url.searchParams.get("cam"));
    if (path === "/meta") return handleMeta(env, url.searchParams.get("cam"));
    if (path === "/cams") return handleCams(env);
    if (path === "/flags") return handleFlags(env, url.searchParams.get("slug"));

    if (path === "/grab") {
      const summary = await runTick(env, new Date());
      // 200 if at least one thing this tick actually succeeded, else 502 —
      // mirrors the old /grab's ok/not-ok contract at the tick level.
      const ok = summary.cams.some((c) => c.ok) || summary.flags?.ok === true;
      return Response.json(summary, { status: ok ? 200 : 502 });
    }

    if (path === "/") {
      return new Response(
        "uw-frame: multi-cam frame courier + Deerfield lifeguard-flag reader. " +
          "GET /frame[?cam=<id>], /meta[?cam=<id>], /cams, /flags?slug=deerfield-beach, /grab.",
        { headers: { "Content-Type": "text/plain" } }
      );
    }

    return new Response("not found", { status: 404 });
  },

  async scheduled(_ctrl: ScheduledController, env: Env): Promise<void> {
    const summary = await runTick(env, new Date());
    // Log for `wrangler tail`; a bad grab is a soft skip (prev good frame
    // for that cam, and the previous flags read, both stand).
    console.log("uw-frame scheduled tick:", JSON.stringify(summary));
  },
};
