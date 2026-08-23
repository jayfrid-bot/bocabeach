import { test, expect, type Page, type ConsoleMessage } from "@playwright/test";
import { mkdirSync } from "node:fs";

/**
 * Mobile-layout regression check.
 *
 * WHY THIS EXISTS: on 2026-08-23 the golden-hour card's color-quality line
 * used `line-clamp-2 sm:line-clamp-1` — one line on phones, invisible at
 * desktop width where the extra room hid the mid-sentence cut. Desktop
 * testing never caught it. This suite renders the real app at real phone
 * widths and asserts NOTHING visibly breaks: no clipped text, no sideways
 * scroll, no undersized tap targets, no console errors.
 *
 * No pixel snapshots — the page shows live conditions (score, temps, tide,
 * cams) that change every few minutes, which would make snapshot diffs pure
 * noise. Every check here is structural (DOM geometry / text), not visual.
 */

const VIEWPORTS = [
  { name: "iphone-390", width: 390, height: 844 },
  { name: "tablet-768", width: 768, height: 1024 },
  { name: "desktop-1280", width: 1280, height: 900 },
] as const;

const PAGES = ["/", "/find"] as const;

const ARTIFACT_DIR = "e2e/artifacts";
mkdirSync(ARTIFACT_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Hydration / data-ready wait
// ---------------------------------------------------------------------------
// The homepage fetches live conditions from many external APIs (NDBC, NOAA,
// GOES, city feeds, tide stations...). Locally that can take a while on a
// cold cache; in CI there are no API keys at all, so every source degrades
// honestly (see lib/sources/*.ts — each source MUST catch its own errors and
// never throw to the UI). The wait below only asks "did the page finish its
// first render", never "did every metric load a real number" — that keeps
// this suite green in CI even with zero external data.

/** Footer stamp (`v0.1.0 · build 1234`) only renders on the dashboard shell
 *  once client hydration completes — see components/ConditionsDashboard.tsx.
 *  BUILD_NUM comes from `git rev-list --count HEAD` at build time, so it's
 *  always present (even with zero API keys), making it a reliable "the app
 *  finished mounting" signal that doesn't depend on any live data loading. */
const BUILD_STAMP_RE = /build\s+\d+/;

/** The ScoreWheel's center rating line is always exactly one of these words
 *  (see lib/scoreBands.ts) — rendered as SVG <text>, not a plain DOM node, so
 *  it can't be found with a role/label locator; text-content matching is the
 *  robust signal here. "Unavailable" covers the fully-degraded (no APIs) case
 *  so this wait also succeeds in CI. */
const SCORE_RATING_RE = /^(Excellent|Good|Decent|Fair|Poor|Unavailable)$/;

async function waitForReady(page: Page, path: string) {
  if (path === "/find") {
    // Static/search page — no live conditions fetch, no footer build stamp.
    // Ready once the heading and at least one beach result are in the DOM.
    await expect(page.getByRole("heading", { name: "Find your beach" })).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.locator('a[href^="/"]').first()).toBeVisible({ timeout: 60_000 });
    return;
  }
  // Dashboard pages ("/" and, in the future, "/<slug>"):
  await expect(page.getByText(BUILD_STAMP_RE)).toBeVisible({ timeout: 60_000 });
  await expect(page.locator("svg text").filter({ hasText: SCORE_RATING_RE }).first()).toBeVisible(
    { timeout: 60_000 },
  );
  // Let the last couple of SWR-driven re-renders / image loads settle before
  // measuring geometry — avoids racing a layout that's still shifting.
  await page.waitForTimeout(500);
}

// ---------------------------------------------------------------------------
// (b) NO CLIPPED TEXT
// ---------------------------------------------------------------------------
// Scan every "card-like" container (rounded-2xl reading tiles, the rounded-xl
// day-outlook chips + top pills at mobile widths where they haven't hit their
// sm:rounded-2xl breakpoint yet, and rounded-full chips/pills) for any element
// whose OWN text is being clipped by `overflow: hidden` — i.e. its content box
// is smaller than its scrollable content. That's exactly the shape of today's
// bug: `line-clamp-2 sm:line-clamp-1` cut the color-quality line mid-word at
// desktop widths.
const CARD_ROOT_SELECTOR =
  '[class*="rounded-2xl"], [class*="rounded-xl"], [class*="rounded-full"]';

/**
 * Allowlist for INTENTIONAL clamps that are expected to occasionally clip —
 * e.g. a decorative aside where losing a word truly doesn't matter. Empty by
 * default on purpose: every entry here is a conscious call that some text is
 * allowed to be cut off, so add one only after confirming (a) the element is
 * genuinely non-essential and (b) a phone-width fallback (like MetricCard's
 * `subShort`) isn't a better fix. Match against the clipped element's own
 * trimmed text content.
 *
 * Example of how to add one:
 *   /^Optional decorative tagline that may run long$/,
 */
const CLIP_ALLOWLIST: RegExp[] = [];

interface ClipOffender {
  card: string;
  text: string;
  tag: string;
  className: string;
  clientWidth: number;
  scrollWidth: number;
  clientHeight: number;
  scrollHeight: number;
}

async function findClippedText(page: Page): Promise<ClipOffender[]> {
  return page.evaluate(
    ({ rootSelector, allowSources }) => {
      const allow = allowSources.map((s: string) => new RegExp(s));
      const seen = new Set<Element>();
      const offenders: ClipOffender[] = [];
      const roots = document.querySelectorAll(rootSelector);
      for (const root of Array.from(roots)) {
        const candidates = [root, ...Array.from(root.querySelectorAll("*"))];
        for (const el of candidates) {
          if (seen.has(el)) continue;
          seen.add(el);
          const text = (el.textContent || "").trim();
          if (!text) continue;
          const style = getComputedStyle(el);
          if (style.display === "none" || style.visibility === "hidden") continue;
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) continue;
          const overflowHidden =
            style.overflow === "hidden" ||
            style.overflowX === "hidden" ||
            style.overflowY === "hidden";
          if (!overflowHidden) continue;
          const clipped =
            el.scrollHeight > el.clientHeight + 2 || el.scrollWidth > el.clientWidth + 2;
          if (!clipped) continue;
          // Single-line ellipsis labels (card headers, beach names, cam
          // names) are INTENTIONALLY truncated — that's what `truncate` is
          // for, not the mid-sentence cut this suite hunts for.
          if (el.classList.contains("truncate")) continue;
          // sr-only elements (e.g. LevelBarChart's per-bar a11y list) are
          // deliberately 1x1/clipped for sighted users by design — they're
          // never visually rendered, so "clipped text" doesn't apply.
          if (el.classList.contains("sr-only")) continue;
          if (allow.some((re) => re.test(text))) continue;

          const cardEl = el.closest(rootSelector);
          const labelEl = cardEl?.querySelector(".truncate");
          const card = labelEl
            ? (labelEl.textContent || "").trim()
            : (cardEl?.textContent || "").trim().slice(0, 40) || "(unknown card)";

          offenders.push({
            card,
            text: text.slice(0, 200),
            tag: el.tagName.toLowerCase(),
            className: String(el.className).slice(0, 120),
            clientWidth: el.clientWidth,
            scrollWidth: el.scrollWidth,
            clientHeight: el.clientHeight,
            scrollHeight: el.scrollHeight,
          });
        }
      }
      return offenders;
    },
    { rootSelector: CARD_ROOT_SELECTOR, allowSources: CLIP_ALLOWLIST.map((r) => r.source) },
  );
}

// ---------------------------------------------------------------------------
// (d) TAP TARGETS (mobile only)
// ---------------------------------------------------------------------------
// Rule: every visible button / link / role=button should have a bounding box
// >= 40x40 (the common "comfortable" mobile tap-target floor). Below that,
// two things can save an element from being a real offender:
//   1. It's on the curated INLINE_LINK_ALLOWLIST below — small plain-text
//      links (footer legal links, "Show all", "Clear") that this app uses
//      deliberately and consistently; they're low-frequency, low-consequence
//      taps, not primary actions, and shrinking the footer to force 40px
//      links would be a worse tradeoff than a slightly fussy tap.
//   2. Its EFFECTIVE hit area (including an ancestor's padding/click area) is
//      >= 40 in both dimensions — some controls sit inside a larger padded
//      parent that itself handles the click.
// Every allowlist entry below was verified against the current, shipped
// design (see the calibration this suite was built from) — it is NOT a
// blanket exemption. A brand-new small button that doesn't match one of
// these patterns will still fail the check.
const INLINE_LINK_ALLOWLIST: RegExp[] = [
  /^Is it beach day\?$/, // site wordmark/logo link — header chrome, not a primary action
  /(Light|Dark) mode$|^Theme$/, // ThemeToggle — site-wide 36px pill-button chrome
  /^↻\s?Refresh(ing…)?$/, // desktop-only refresh affordance (mobile has pull-to-refresh)
  /^＋ Other beaches$/, // secondary nav pill under the score
  /^Show (all|less)/, // ChangelogSection expand/collapse
  /^Support$/,
  /^Privacy$/,
  /^iPhone app$/,
  /^hello@isitbeachday\.com$/,
  /^Tell us where to add next\??$/,
  /^turn off$/, // NotifyButton's inline "disable" link
  /^Clear$/, // BeachFinder's "clear location" link
];

/** Elements whose only accessible name is an icon (e.g. the "ⓘ" info toggle)
 *  are matched by aria-label instead of visible text. */
const ARIA_LABEL_ALLOWLIST: RegExp[] = [
  /^(Show|Hide) the science behind/, // AdvisoryStrip's 24x24 info-disclosure toggle
];

const MIN_TAP = 40;

interface TapOffender {
  text: string;
  ariaLabel: string | null;
  tag: string;
  className: string;
  width: number;
  height: number;
}

async function findTapTargetOffenders(page: Page): Promise<TapOffender[]> {
  return page.evaluate(
    ({ min, inlineSources, ariaSources }) => {
      const inlineAllow = inlineSources.map((s: string) => new RegExp(s));
      const ariaAllow = ariaSources.map((s: string) => new RegExp(s));
      const offenders: TapOffender[] = [];
      const els = document.querySelectorAll('button, a[href], [role="button"]');
      for (const el of Array.from(els)) {
        const style = getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") continue;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue; // not actually rendered
        if (rect.width >= min && rect.height >= min) continue;

        const text = (el.textContent || "").trim();
        const ariaLabel = el.getAttribute("aria-label");
        if (inlineAllow.some((re) => re.test(text))) continue;
        if (ariaLabel && ariaAllow.some((re) => re.test(ariaLabel))) continue;

        // Effective hit area via a padded ancestor (e.g. an icon wrapped in a
        // larger clickable parent list item).
        let effective = rect;
        let parent = el.parentElement;
        let hops = 0;
        while (parent && hops < 3) {
          const pr = parent.getBoundingClientRect();
          if (pr.width > effective.width || pr.height > effective.height) effective = pr;
          parent = parent.parentElement;
          hops++;
        }
        if (effective.width >= min && effective.height >= min) continue;

        offenders.push({
          text: text.slice(0, 60),
          ariaLabel,
          tag: el.tagName.toLowerCase(),
          className: String(el.className).slice(0, 120),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        });
      }
      return offenders;
    },
    {
      min: MIN_TAP,
      inlineSources: INLINE_LINK_ALLOWLIST.map((r) => r.source),
      ariaSources: ARIA_LABEL_ALLOWLIST.map((r) => r.source),
    },
  );
}

// ---------------------------------------------------------------------------
// (e) console errors
// ---------------------------------------------------------------------------
const BENIGN_CONSOLE_PATTERNS = [
  /favicon\.ico/i,
  /video-monitoring\.com/i, // third-party beach-cam stills; provider-side failures aren't our bug
  /\[Fast Refresh\]/i, // Next dev HMR chatter
  /\[HMR\]/i,
  /webpack-hmr/i,
  /cloudflareinsights\.com/i, // analytics beacon (app/layout.tsx) — blocked by CORS from localhost in dev/CI, works fine on the real domain
  // Chromium sometimes stamps a transient inline `style` (an autofill
  // heuristic — its exact content is non-deterministic run to run: seen as
  // both `caret-color: transparent` and an empty `style={{}}`) onto
  // BeachFinder's search <input> before React hydrates, which React then
  // reports as a mismatch. The app never sets a `style` prop on that input
  // (only `className`), so this is Chrome's doing, not ours. Matched
  // narrowly — a real hydration mismatch on that input (text/props actually
  // wrong) would show a different diff shape and wouldn't hit this pattern.
  /hydrated but some attributes[\s\S]*aria-label="Search beaches"/,
];

function isBenignConsoleText(text: string): boolean {
  return BENIGN_CONSOLE_PATTERNS.some((re) => re.test(text));
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------
for (const path of PAGES) {
  for (const vp of VIEWPORTS) {
    test(`${path === "/" ? "home" : path} @ ${vp.name} — no clipping, no overflow, tap targets, no console errors`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });

      // The Cloudflare Insights analytics beacon (app/layout.tsx) can't reach
      // its endpoint from a localhost origin (CORS) — that's dev/CI-only
      // noise, not our bug (it works fine on the real domain). Chrome's error
      // text for the resulting failure varies ("...blocked by CORS policy",
      // a bare "Failed to load resource: net::ERR_FAILED", etc.). Aborting
      // the request still logs a load-failure to the console, so instead
      // fulfill it with an inert empty response — no request ever fails.
      await page.route("**://static.cloudflareinsights.com/**", (route) =>
        route.fulfill({ status: 200, contentType: "application/javascript", body: "" }),
      );
      await page.route("**://cloudflareinsights.com/**", (route) =>
        route.fulfill({ status: 200, contentType: "text/plain", body: "" }),
      );

      const consoleErrors: string[] = [];
      const onConsole = (msg: ConsoleMessage) => {
        if (msg.type() !== "error") return;
        const text = msg.text();
        if (isBenignConsoleText(text)) return;
        consoleErrors.push(text);
      };
      const pageErrors: string[] = [];
      page.on("console", onConsole);
      page.on("pageerror", (err) => pageErrors.push(err.message));

      await page.goto(path, { waitUntil: "domcontentloaded" });
      await waitForReady(page, path);

      // (f) screenshot artifact — human-review aid only, never asserted on.
      const slug = path === "/" ? "home" : path.replace(/^\//, "");
      await page
        .screenshot({ path: `${ARTIFACT_DIR}/${slug}-${vp.name}.png`, fullPage: true })
        .catch(() => {
          /* best-effort; never fail the suite over a screenshot */
        });

      // (c) NO HORIZONTAL OVERFLOW
      const overflowInfo = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
      }));
      expect(
        overflowInfo.scrollWidth,
        `page scrolls horizontally: documentElement.scrollWidth=${overflowInfo.scrollWidth} > window.innerWidth=${overflowInfo.innerWidth}`,
      ).toBeLessThanOrEqual(overflowInfo.innerWidth + 1);

      // (b) NO CLIPPED TEXT
      const clipped = await findClippedText(page);
      expect(
        clipped,
        `clipped text found at ${vp.name} on ${path}:\n` +
          clipped
            .map(
              (o) =>
                `  [${o.card}] "${o.text}" (<${o.tag} class="${o.className}">, ` +
                `content ${o.scrollWidth}x${o.scrollHeight} in box ${o.clientWidth}x${o.clientHeight})`,
            )
            .join("\n"),
      ).toEqual([]);

      // (d) TAP TARGETS — mobile viewport only
      if (vp.width < 768) {
        const tapOffenders = await findTapTargetOffenders(page);
        expect(
          tapOffenders,
          `undersized tap targets (<${MIN_TAP}x${MIN_TAP}) at ${vp.name} on ${path}:\n` +
            tapOffenders
              .map(
                (o) =>
                  `  "${o.text}"${o.ariaLabel ? ` [aria-label="${o.ariaLabel}"]` : ""} ` +
                  `<${o.tag} class="${o.className}"> ${o.width}x${o.height}`,
              )
              .join("\n"),
        ).toEqual([]);
      }

      // (e) NO CONSOLE ERRORS
      expect(
        consoleErrors,
        `console errors at ${vp.name} on ${path}:\n${consoleErrors.join("\n")}`,
      ).toEqual([]);
      expect(
        pageErrors,
        `uncaught page errors at ${vp.name} on ${path}:\n${pageErrors.join("\n")}`,
      ).toEqual([]);

      page.off("console", onConsole);
    });
  }
}
