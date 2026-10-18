import { test, expect } from "@playwright/test";

/**
 * /admin/review for a phone that is NOT enrolled: one "Owner code" box and one "Enroll" button, and nothing
 * else. This is the door the owner uses inside the iPhone app (no address bar). The code goes in a request
 * body, never an address, and the box is cleared after the try.
 */
test.use({ viewport: { width: 390, height: 844 } });

test("a stranger sees only the owner code box, and a try leaves the address and the box clean", async ({ page }) => {
  await page.goto("/admin/review");
  const box = page.getByLabel("Owner code");
  const enroll = page.getByRole("button", { name: "Enroll" });
  await expect(box).toBeVisible();
  await expect(enroll).toBeVisible();

  // Nothing that says what the page is, and nothing that looks like the owner's tools.
  const text = (await page.locator("body").innerText()).replace(/\s+/g, " ");
  expect(text).not.toMatch(/quality review|report conditions|numbers the app was not sure/i);

  // Phone width: no sideways scroll, and a finger-sized button.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  const h = (await enroll.boundingBox())?.height ?? 0;
  expect(h).toBeGreaterThanOrEqual(44);

  // A wrong code: sent in the body, refused, the box emptied, the address untouched.
  const requests: { url: string; body: string | null }[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/quality/owner/enroll")) requests.push({ url: r.url(), body: r.postData() });
  });
  await box.fill("not-the-code-0123456789");
  await enroll.click();
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0].url).not.toContain("not-the-code");
  expect(requests[0].body).toContain("not-the-code-0123456789");
  await expect(box).toHaveValue("");
  // Next's own (empty) route announcer is also role="alert"; once the page hydrates fast
  // enough to have it by now, a bare getByRole("alert") matches both. Ask for the one with words.
  await expect(page.getByRole("alert").filter({ hasText: /\S/ })).toBeVisible();
  expect(page.url()).not.toContain("not-the-code");
  expect(page.url()).toMatch(/\/admin\/review$/);
});
