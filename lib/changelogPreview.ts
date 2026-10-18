// The slice of the changelog the page carries: the newest few entries and the
// total. The full list (lib/changelog.ts, ~18 KB of script and growing) is
// imported only HERE, by server code and the owner console; the browser fetches
// it separately when someone taps "Show all" (components/ChangelogSection.tsx).

import { CHANGELOG, type ChangelogEntry } from "@/lib/changelog";

/** How many entries sit in the page before "Show all". */
export const CHANGELOG_PREVIEW_COUNT = 3;

export interface ChangelogPreview {
  recent: ChangelogEntry[];
  total: number;
}

export function changelogPreview(): ChangelogPreview {
  return { recent: CHANGELOG.slice(0, CHANGELOG_PREVIEW_COUNT), total: CHANGELOG.length };
}
