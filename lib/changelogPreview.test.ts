import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChangelogSection } from "@/components/ChangelogSection";
import { CHANGELOG } from "@/lib/changelog";
import { changelogPreview, CHANGELOG_PREVIEW_COUNT } from "@/lib/changelogPreview";

describe("changelogPreview", () => {
  it("carries the newest entries and the true total", () => {
    const p = changelogPreview();
    expect(p.recent).toEqual(CHANGELOG.slice(0, CHANGELOG_PREVIEW_COUNT));
    expect(p.total).toBe(CHANGELOG.length);
  });

  it("renders the newest entries and 'Show all (N)' into the server HTML", () => {
    const html = renderToString(createElement(ChangelogSection, changelogPreview()));
    for (const e of CHANGELOG.slice(0, CHANGELOG_PREVIEW_COUNT)) {
      expect(html).toContain(e.title.replace(/'/g, "&#x27;").replace(/&/g, "&amp;"));
    }
    expect(html).toContain(`Show all (${CHANGELOG.length})`);
  });

  it("keeps the full changelog out of the client component's static imports", () => {
    // The whole list is fetched on 'Show all'; a static value import would put it back in the bundle.
    const src = readFileSync("components/ChangelogSection.tsx", "utf8");
    expect(src).not.toMatch(/import\s*\{[^}]*\bCHANGELOG\b[^}]*\}\s*from\s*["']@\/lib\/changelog["']/);
    expect(src).toMatch(/import\("@\/lib\/changelog"\)/);
  });
});
