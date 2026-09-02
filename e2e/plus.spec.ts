import { test, expect, type Page, type ConsoleMessage } from "@playwright/test";

/**
 * Beach Day Plus — the doors, the one-time reveal, and what a subscriber sees.
 *
 * Everything here runs at 390 px (the phone width the layout gate uses) against
 * the real app with a real device row, so it exercises the actual API routes,
 * not a mock. The rules it protects:
 *
 *   1. A free user sees the whole dashboard and a door. No personal number, no
 *      onboarding in the way.
 *   2. The questions run once and end with the reveal.
 *   3. A subscriber's own number is the headline, with everyone's one tap away.
 *
 * Live conditions come from many external APIs and are slow (and keyless) in CI,
 * so every wait keys off structure, never off a particular temperature.
 */

const PHONE = { width: 390, height: 844 };

/** The ScoreWheel's centre word — the last thing to render, so its presence
 *  means the dashboard has hydrated. Kept in sync with lib/scoreBands.ts. */
const SCORE_RATING_RE = /^(Excellent|Good|Decent|Marginal|Poor|Unavailable)$/;

const BENIGN_CONSOLE = [
  /favicon\.ico/i,
  /video-monitoring\.com/i,
  /\[Fast Refresh\]/i,
  /\[HMR\]/i,
  /webpack-hmr/i,
  /cloudflareinsights\.com/i,
  // The app-shell test below fakes the Capacitor User-Agent in a desktop
  // browser, so the native plugins genuinely are absent and Capacitor says so
  // before our own try/catch can swallow it. On a real device they exist.
  /plugin is not implemented on web/i,
];

async function openDashboard(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on("console", (msg: ConsoleMessage) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    if (BENIGN_CONSOLE.some((re) => re.test(text))) return;
    errors.push(text);
  });
  page.on("pageerror", (err) => {
    // Same filter as the console: the faked app User-Agent makes Capacitor
    // reject from a listener registration, which arrives here rather than as a
    // console message.
    if (BENIGN_CONSOLE.some((re) => re.test(err.message))) return;
    errors.push(err.message);
  });

  await page.setViewportSize(PHONE);
  await page.route("**://static.cloudflareinsights.com/**", (route) =>
    route.fulfill({ status: 200, contentType: "application/javascript", body: "" }),
  );
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByText(/build\s+\d+/)).toBeVisible({ timeout: 60_000 });
  await expect(
    page.locator("svg text").filter({ hasText: SCORE_RATING_RE }).first(),
  ).toBeVisible({ timeout: 60_000 });
  await page.waitForTimeout(400);
  return errors;
}

/** Every visible control inside a container must be a real tap target. */
async function undersizedTapTargets(page: Page, selector: string): Promise<string[]> {
  return page.evaluate((sel) => {
    const root = document.querySelector(sel);
    if (!root) return ["container not found"];
    const bad: string[] = [];
    for (const el of Array.from(root.querySelectorAll('button, a[href], select, input, [role="button"]'))) {
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if (rect.width >= 40 && rect.height >= 40) continue;
      bad.push(`"${(el.textContent || el.getAttribute("aria-label") || "").trim().slice(0, 40)}" ${Math.round(rect.width)}x${Math.round(rect.height)}`);
    }
    return bad;
  }, selector);
}

/** Nothing inside a container may be cut off by its own overflow. */
async function clippedText(page: Page, selector: string): Promise<string[]> {
  return page.evaluate((sel) => {
    const root = document.querySelector(sel);
    if (!root) return ["container not found"];
    const bad: string[] = [];
    for (const el of Array.from(root.querySelectorAll("*"))) {
      const text = (el.textContent || "").trim();
      if (!text) continue;
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") continue;
      if (el.classList.contains("truncate") || el.classList.contains("sr-only")) continue;
      const hidden =
        style.overflow === "hidden" || style.overflowX === "hidden" || style.overflowY === "hidden";
      if (!hidden) continue;
      if (el.scrollHeight > el.clientHeight + 2 || el.scrollWidth > el.clientWidth + 2) {
        bad.push(`"${text.slice(0, 60)}"`);
      }
    }
    return bad;
  }, selector);
}

test.describe("Beach Day Plus", () => {
  test("free dashboard offers the door and shows no personal score", async ({ page }) => {
    const errors = await openDashboard(page);

    // The door is there…
    await expect(page.getByRole("button", { name: /Personalize my score/ })).toBeVisible();
    // …and nothing has been personalized yet.
    await expect(page.getByRole("group", { name: "Which score to show" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Your score$/ })).toHaveCount(0);

    // The free dashboard is still all there.
    await expect(page.getByRole("heading", { name: "Explore the details" })).toBeVisible();
    // Safety information is free, for everybody.
    await expect(page.getByText(/^(Swim safety|Surf conditions):/)).toBeVisible();

    expect(errors, `console errors: ${errors.join("\n")}`).toEqual([]);
  });

  test("the first launch offers the nearest beach, once", async ({ page }) => {
    await openDashboard(page);
    const region = page.getByRole("region", { name: "Nearest beach" });
    const banner = region.getByRole("button", { name: "Find my nearest beach" });
    await expect(banner).toBeVisible();
    // Dismissing it retires it for good.
    await region.getByRole("button", { name: "Dismiss" }).click();
    await expect(banner).toHaveCount(0);
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByText(/build\s+\d+/)).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole("button", { name: "Find my nearest beach" })).toHaveCount(0);
  });

  test("the questions run once and end at the reveal", async ({ page }) => {
    const errors = await openDashboard(page);
    await page.getByRole("button", { name: /Personalize my score/ }).click();

    const sheet = page.getByRole("dialog");
    await expect(sheet).toBeVisible();
    await expect(sheet.getByText("What do you go to the beach for?")).toBeVisible();

    // Nothing picked yet, so there is nowhere to go.
    const go = sheet.getByRole("button", { name: "See my score" });
    await expect(go).toBeDisabled();

    await sheet.getByRole("button", { name: "Snorkeling" }).click();
    await sheet.getByRole("button", { name: "Hot" }).click();
    await sheet.getByRole("button", { name: "Not really" }).click();

    // The answers stick, and picking one heat answer un-picks the last.
    await expect(sheet.getByRole("button", { name: "Snorkeling" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(sheet.getByRole("button", { name: "Hot" })).toHaveAttribute("aria-pressed", "true");
    await expect(sheet.getByRole("button", { name: "Just right" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );

    // Nothing in this sheet may be cut off or too small to hit at 390 px.
    expect(await clippedText(page, '[role="dialog"]')).toEqual([]);
    expect(await undersizedTapTargets(page, '[role="dialog"]')).toEqual([]);

    await expect(go).toBeEnabled();
    await go.click();

    // The reveal: their number, everyone's number, what it is tuned for.
    await expect(sheet.getByText("Your score today")).toBeVisible();
    await expect(sheet.getByText(/Everyone's score today is/)).toBeVisible();
    await expect(sheet.getByText(/Tuned for snorkeling/)).toBeVisible();

    // …then the paywall, with the price and the trial in plain sight.
    await sheet.getByRole("button", { name: "Keep my score" }).click();
    await expect(sheet.getByText("$2.99/mo · $19.99/yr")).toBeVisible();
    await expect(sheet.getByRole("button", { name: "Start 3-day free trial" })).toBeVisible();

    // Escape closes it, and the door is now the locked pill — no second run.
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Your score/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Personalize my score/ })).toHaveCount(0);

    expect(errors, `console errors: ${errors.join("\n")}`).toEqual([]);
  });

  test("declining leaves a locked pill that reopens the paywall, not the questions", async ({
    page,
  }) => {
    await openDashboard(page);
    await page.getByRole("button", { name: /Personalize my score/ }).click();
    const sheet = page.getByRole("dialog");
    await sheet.getByRole("button", { name: "Swimming" }).click();
    await sheet.getByRole("button", { name: "See my score" }).click();
    await expect(sheet.getByText("Your score today")).toBeVisible();
    await page.keyboard.press("Escape");

    // Reopening goes straight to the offer.
    await page.getByRole("button", { name: /Your score/ }).click();
    await expect(page.getByRole("dialog").getByText("$2.99/mo · $19.99/yr")).toBeVisible();
    await expect(page.getByRole("dialog").getByText("What do you go to the beach for?")).toHaveCount(0);
  });

  test("a trial makes the personal number the headline", async ({ page }) => {
    const errors = await openDashboard(page);
    await page.getByRole("button", { name: /Personalize my score/ }).click();
    const sheet = page.getByRole("dialog");
    await sheet.getByRole("button", { name: "Snorkeling" }).click();
    await sheet.getByRole("button", { name: "See my score" }).click();
    await sheet.getByRole("button", { name: "Keep my score" }).click();

    const trial = sheet.getByRole("button", { name: "Start 3-day free trial" });
    await expect(trial).toBeVisible();
    await trial.click();

    // The sheet closes itself once the server confirms, and the headline flips.
    await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 20_000 });
    const toggle = page.getByRole("group", { name: "Which score to show" });
    await expect(toggle).toBeVisible();
    await expect(toggle.getByRole("button", { name: "Your score" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    // The door is gone: a subscriber's number IS the headline.
    await expect(page.getByRole("button", { name: /Personalize my score/ })).toHaveCount(0);

    // Everyone's score stays one tap away.
    await toggle.getByRole("button", { name: "Everyone's" }).click();
    await expect(toggle.getByRole("button", { name: "Everyone's" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    // And the settings sheet opens, live, without clipping anything.
    await page.getByRole("button", { name: "Beach Day Plus settings" }).click();
    const settings = page.getByRole("dialog");
    await expect(settings.getByText("What you come here for")).toBeVisible();
    await expect(settings.getByLabel("Home beach")).toBeVisible();
    expect(await clippedText(page, '[role="dialog"]')).toEqual([]);
    expect(await undersizedTapTargets(page, '[role="dialog"]')).toEqual([]);

    expect(errors, `console errors: ${errors.join("\n")}`).toEqual([]);
  });
});

// The app shell is detected from the request User-Agent (lib/nativeRequest.ts),
// so a UA carrying the Capacitor tag renders exactly what a phone gets: the
// Alerts button and Beach Mode, neither of which exists in a browser.
test.describe("inside the app shell", () => {
  test.use({
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 IsItBeachDayApp/ios",
  });

  test("Beach Mode and Alerts are doors to Plus, never dead ends", async ({ page }) => {
    const errors = await openDashboard(page);

    // Beach Mode explains itself before it asks for anything.
    const beachMode = page.getByRole("button", { name: /Get alerts where you stand/ });
    await expect(beachMode).toBeVisible();

    // Alerts exists here and nowhere else.
    await expect(page.getByRole("button", { name: /🔔 Alerts/ })).toBeVisible();

    // Either door opens the same questions.
    await beachMode.click();
    await expect(page.getByRole("dialog").getByText("What do you go to the beach for?")).toBeVisible();
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: /🔔 Alerts/ }).click();
    await expect(page.getByRole("dialog").getByText("What do you go to the beach for?")).toBeVisible();

    expect(errors, `console errors: ${errors.join("\n")}`).toEqual([]);
  });
});
