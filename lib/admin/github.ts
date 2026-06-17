// Commit an admin-added Location into config/locations.generated.json via the
// GitHub Contents API. The resulting commit to `main` triggers a Netlify deploy,
// after which the new beach is a live, routable location. Server-only (uses
// ADMIN_GH_TOKEN). The pure `buildGeneratedContent` is unit-tested; the network
// commit supports a `dryRun` rehearsal.

import type { Location } from "@/lib/types";

const REPO = process.env.ADMIN_GH_REPO?.trim() || "jayfrid-bot/bocabeach";
const BRANCH = process.env.ADMIN_GH_BRANCH?.trim() || "main";
const PATH = "config/locations.generated.json";
const API = "https://api.github.com";

export interface AddResult {
  ok: boolean;
  dryRun?: boolean;
  reason?: string;
  slug?: string;
  commitUrl?: string;
  /** Total generated locations after the add. */
  count?: number;
  /** The would-be file content (dry run only). */
  preview?: string;
  /** The commit message. */
  message?: string;
}

/**
 * Pure: merge a new location into the existing generated list (rejecting a
 * duplicate slug) and serialize it the way the committed file should read.
 */
export function buildGeneratedContent(
  existing: Location[],
  loc: Location,
): { next: Location[]; json: string } | { duplicate: true } {
  if (existing.some((l) => l && l.slug === loc.slug)) return { duplicate: true };
  const next = [...existing, loc];
  const json = JSON.stringify(next, null, 2) + "\n";
  return { next, json };
}

function ghToken(): string | undefined {
  const t = process.env.ADMIN_GH_TOKEN?.trim();
  return t ? t : undefined;
}

function ghHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "isitbeachday-admin",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

/**
 * Append `loc` to the generated-locations file and commit it. `dryRun` does
 * everything except the final write. Never throws — returns {ok:false, reason}.
 */
export async function addLocationCommit(
  loc: Location,
  opts: { dryRun?: boolean } = {},
): Promise<AddResult> {
  const token = ghToken();
  if (!token) return { ok: false, reason: "commit not configured — set ADMIN_GH_TOKEN" };
  const headers = ghHeaders(token);

  // 1) Read the current generated file (content + sha), tolerating a missing file.
  let existing: Location[] = [];
  let sha: string | undefined;
  try {
    const res = await fetch(`${API}/repos/${REPO}/contents/${PATH}?ref=${BRANCH}`, {
      headers,
      cache: "no-store",
    });
    if (res.status === 200) {
      const j = (await res.json()) as { sha?: string; content?: string };
      sha = j.sha;
      const decoded = Buffer.from(j.content ?? "", "base64").toString("utf8").trim();
      const parsed = JSON.parse(decoded || "[]");
      if (Array.isArray(parsed)) existing = parsed as Location[];
    } else if (res.status !== 404) {
      return { ok: false, reason: `GitHub read failed (${res.status})` };
    }
  } catch (e) {
    return { ok: false, reason: `GitHub read error: ${String(e)}` };
  }

  const built = buildGeneratedContent(existing, loc);
  if ("duplicate" in built) {
    return { ok: false, reason: `slug "${loc.slug}" already exists`, slug: loc.slug };
  }
  const message = `admin: add ${loc.name} (${loc.slug})`;

  if (opts.dryRun) {
    return { ok: true, dryRun: true, slug: loc.slug, count: built.next.length, preview: built.json, message };
  }

  // 2) Commit the new content.
  try {
    const body: Record<string, unknown> = {
      message,
      content: Buffer.from(built.json, "utf8").toString("base64"),
      branch: BRANCH,
    };
    if (sha) body.sha = sha;
    const res = await fetch(`${API}/repos/${REPO}/contents/${PATH}`, {
      method: "PUT",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
    });
    if (res.status === 200 || res.status === 201) {
      const j = (await res.json()) as { commit?: { html_url?: string } };
      return { ok: true, slug: loc.slug, count: built.next.length, commitUrl: j.commit?.html_url, message };
    }
    const txt = await res.text();
    return { ok: false, reason: `GitHub commit failed (${res.status}): ${txt.slice(0, 200)}` };
  } catch (e) {
    return { ok: false, reason: `GitHub commit error: ${String(e)}` };
  }
}
