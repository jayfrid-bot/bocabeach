/**
 * uw-frame — cloud-side underwater sea-cam frame courier.
 *
 * Replaces the Mac launchd courier (scripts/uw_frame_local.sh) that grabbed one
 * frame per hour from Deerfield Beach's "Spinner the Sea Cam" underwater YouTube
 * livestream (video id SHfAtWHr9Ks) for water-clarity calibration. YouTube blocks
 * yt-dlp from GitHub datacenter IPs (every player client), and the live-thumbnail
 * trick fails because custom cover art overrides it — so we open the stream in a
 * real headless Chrome (Cloudflare Browser Rendering), wait for the <video> to be
 * actually playing, and screenshot the video region.
 *
 * WHY AN IFRAME ON OUR OWN ORIGIN (not the bare embed URL):
 *   Loading https://www.youtube.com/embed/<id> as a TOP-LEVEL document fails with
 *   "Error 153 — Video player configuration error": YouTube's player only runs
 *   correctly when embedded in an <iframe> under a real http(s) origin (that is
 *   how the city's own page embeds it). So the worker serves its own /host page
 *   containing the iframe, navigates headless Chrome to that page (real https
 *   origin = this worker), and drives the cross-origin YouTube frame via
 *   puppeteer's frame API (automation is not bound by same-origin policy).
 *
 * ENDPOINTS
 *   GET /frame  -> image/jpeg of the last good frame (+ X-Grabbed-At header)
 *   GET /meta   -> JSON {grabbedAtUtc, bytes, width, height} or {grabbedAtUtc:null}
 *   GET /grab   -> run the grab logic on demand (proves the pipeline via curl);
 *                  returns JSON {ok, ...}. Same code path as the cron handler.
 *   GET /host   -> internal: the iframe host page the headless browser loads.
 *   GET /       -> tiny help text.
 *
 * SCHEDULE: crons "0 10-23 * * *" + "0 0 * * *" — top of each hour 10:00-24:00
 * UTC (~6 AM-8 PM ET), 15 grabs/day.
 *
 * BROWSER-RENDERING BUDGET (free tier ~10 browser-minutes/day):
 *   Each session is kept SHORT — no networkidle waits, a hard ~25s cap on the
 *   play-poll, browser closed in a finally block. 15 sessions/day x ~25s worst
 *   case ~= 6-7 browser-minutes/day, inside the free cap. Do NOT add long waits.
 *   (Free tier also caps concurrent browsers + new-browser rate: a burst of grabs
 *   returns 429 "Rate limit exceeded" — harmless, the cron only fires hourly.)
 *
 * QUALITY GUARD: a screenshot smaller than MIN_GOOD_BYTES (likely a black/blank
 * frame) is REJECTED and never overwrites a previously stored good frame. Public
 * read is fine (it's a public cam frame); no auth on the read paths.
 */
import puppeteer from "@cloudflare/puppeteer";

export interface Env {
  BROWSER: Fetcher; // Browser Rendering binding
  UW_FRAME: KVNamespace;
}

const VIDEO_ID = "SHfAtWHr9Ks";
const EMBED_URL =
  `https://www.youtube.com/embed/${VIDEO_ID}?autoplay=1&mute=1&playsinline=1&rel=0`;
// This worker's own origin — the iframe host page must be served from a real
// https origin so the YouTube embed inside it gets a valid referrer (fixes 153).
const SELF_ORIGIN = "https://uw-frame.entwined-app.workers.dev";
const KEY_FRAME = "frame:latest"; // base64 JPEG bytes
const KEY_META = "frame:meta"; // JSON {grabbedAtUtc, bytes, width, height}
const MIN_GOOD_BYTES = 15_000; // reject suspiciously-small (likely black) frames
const PLAY_TIMEOUT_MS = 25_000; // hard cap on waiting for a real playing frame
const VIEWPORT = { width: 1280, height: 720 };

const HOST_HTML =
  `<!doctype html><html><head><meta charset="utf-8">` +
  `<style>html,body{margin:0;padding:0;background:#000;overflow:hidden}` +
  `iframe{border:0;display:block}</style></head><body>` +
  `<iframe id="yt" width="${VIEWPORT.width}" height="${VIEWPORT.height}" ` +
  `allow="autoplay; encrypted-media" allowfullscreen ` +
  `src="${EMBED_URL}"></iframe></body></html>`;

interface Meta {
  grabbedAtUtc: string;
  bytes: number;
  width: number;
  height: number;
}

function nowUtc(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

async function readMeta(env: Env): Promise<Meta | null> {
  const raw = await env.UW_FRAME.get(KEY_META);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Meta;
  } catch {
    return null;
  }
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

/**
 * Grab one frame. Returns a result object; NEVER throws — the caller (cron or
 * /grab) treats a bad result as a soft skip so the previous good frame stands.
 */
async function grab(env: Env): Promise<{
  ok: boolean;
  reason?: string;
  meta?: Meta;
  stored?: boolean;
}> {
  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | null = null;
  try {
    browser = await puppeteer.launch(env.BROWSER);
    const page = await browser.newPage();
    await page.setViewport(VIEWPORT);
    // Load OUR host page (real origin); the YouTube embed lives in its iframe.
    await page.goto(`${SELF_ORIGIN}/host`, {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });

    // Grab a handle to the YouTube iframe and its (cross-origin) content frame.
    const iframeEl = await page.waitForSelector("iframe#yt", { timeout: 8_000 });
    if (!iframeEl) return { ok: false, reason: "iframe not found" };
    const frame = await iframeEl.contentFrame();
    if (!frame) return { ok: false, reason: "no content frame" };

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
    const start = Date.now();
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
        return { ok: false, reason: "video unavailable (embed error overlay)" };
      }
      if (state.ready >= 2 && state.t > 0) {
        playing = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 700));
    }
    if (!playing) {
      return { ok: false, reason: "timed out waiting for a playing frame" };
    }

    // Clean up the frame so it's mostly water — matching the old ffmpeg courier.
    // Two layers, both cosmetic (a failure here never fails the grab):
    //  (1) inject CSS to force-hide YouTube's control chrome + cursor, then
    //  (2) leave the player untouched for ~3.5s so YouTube's own inactivity
    //      timer fades whatever chrome the CSS didn't catch.
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
    // Inactivity fade — no interaction during this wait. Kept short for budget.
    await new Promise((r) => setTimeout(r, 3500));

    // Screenshot the video region. Prefer the <video> element inside the frame;
    // fall back to the iframe element, then the full viewport.
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

    // JPEG magic + size guard: reject tiny (likely black/blank) frames.
    const isJpeg = shot.length > 2 && shot[0] === 0xff && shot[1] === 0xd8;
    if (!isJpeg) {
      return { ok: false, reason: `not a JPEG (${shot.length} bytes)` };
    }
    if (shot.length < MIN_GOOD_BYTES) {
      return {
        ok: false,
        reason: `frame too small (${shot.length} < ${MIN_GOOD_BYTES}) — likely blank`,
      };
    }

    const meta: Meta = {
      grabbedAtUtc: nowUtc(),
      bytes: shot.length,
      width: VIEWPORT.width,
      height: VIEWPORT.height,
    };
    await env.UW_FRAME.put(KEY_FRAME, bytesToB64(shot));
    await env.UW_FRAME.put(KEY_META, JSON.stringify(meta));
    return { ok: true, meta, stored: true };
  } catch (e) {
    return { ok: false, reason: `grab error: ${(e as Error).message}` };
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {
        /* ignore */
      }
    }
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/host") {
      // Internal iframe host page loaded by the headless browser only.
      return new Response(HOST_HTML, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    if (path === "/frame") {
      const b64 = await env.UW_FRAME.get(KEY_FRAME);
      const meta = await readMeta(env);
      if (!b64 || !meta) {
        return new Response("no frame yet", { status: 404 });
      }
      return new Response(b64ToBytes(b64), {
        headers: {
          "Content-Type": "image/jpeg",
          "X-Grabbed-At": meta.grabbedAtUtc,
          "Cache-Control": "public, max-age=300",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    if (path === "/meta") {
      const meta = await readMeta(env);
      return Response.json(meta ?? { grabbedAtUtc: null }, {
        headers: { "Access-Control-Allow-Origin": "*" },
      });
    }

    if (path === "/grab") {
      const r = await grab(env);
      return Response.json(r, { status: r.ok ? 200 : 502 });
    }

    if (path === "/") {
      return new Response(
        "uw-frame: GET /frame (jpeg), /meta (json), /grab (on-demand grab). " +
          "Hourly cron grabs a Deerfield underwater sea-cam frame via Browser Rendering.",
        { headers: { "Content-Type": "text/plain" } }
      );
    }

    return new Response("not found", { status: 404 });
  },

  async scheduled(_ctrl: ScheduledController, env: Env): Promise<void> {
    const r = await grab(env);
    // Log for `wrangler tail`; a bad grab is a soft skip (prev good frame stands).
    console.log("uw-frame scheduled grab:", JSON.stringify(r));
  },
};
