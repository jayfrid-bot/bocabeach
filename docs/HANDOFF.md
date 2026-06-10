# Build & Session Handoff — Boca Beach Rats

> Snapshot for continuing this project in a **fresh (local) Claude Code / dev session**.
> Read this top-to-bottom and you'll have full context without the prior chat.
>
> Last updated: 2026-06-10 · `main` @ `ce7b845` · app version `0.1.0`

---

## 1. What this is

A **Next.js (App Router) + TypeScript + Tailwind** app that consolidates live beach
conditions for a town and distills them into two composite 0–100 scores: a **Beach Day**
score (for beachgoers) and a **Surf** score. Built **config-first** — adding a new beach
town is a single entry in `config/locations.ts`. Long-term goal: every beach town, and
eventual monetization.

Deployed on **Netlify** (`@netlify/plugin-nextjs`). All external data is fetched
**server-side** with per-source `next.revalidate` caching.

See `README.md` for the full data-source list and `CLAUDE.md` for conventions/guardrails.

---

## 2. Local setup (do this first in the new session)

```bash
git clone https://github.com/jayfrid-bot/bocabeach.git
cd bocabeach
git checkout claude/ecstatic-hopper-iRGHU   # active dev branch (see §7)
npm install
npm run dev        # http://localhost:3000  (default town: /boca-raton)
npm test           # Vitest — parsers + scoring (126 tests, all green)
npm run lint
npm run build
```

**Env vars** (all optional — v1 runs keyless; see `.env.example`):
- `STORMGLASS_API_KEY` — richer swell (optional).
- `FL_HEALTHY_BEACHES_APPKEY` — override water-quality DataPage key (optional).
- `HERE_API_KEY` — per-beach traffic score. Set as a **host (Netlify) env var**, not a
  GitHub secret — the Next app calls HERE live, server-side.
- `CONDITIONS_USER_AGENT` — descriptive UA for `api.weather.gov`.

The **vision pipeline keys** (`GEMINI_API_KEY`, `GROQ_API_KEY`, `OPENROUTER_API_KEY`)
live in **GitHub Actions secrets**, not in the app — see §5.

---

## 3. Architecture (read these files first)

- `config/locations.ts` — **source of truth**. Adding a town = one entry.
- `lib/types.ts` — shared domain types; every source returns `Wrapped<T>` with a status.
- `lib/sources/*` — one adapter per data source. **Each catches its own errors and returns
  `Wrapped<T>` (never throws to the UI).** Pure parsers are split out + unit-tested.
- `lib/conditions.ts` — fetches all sources in parallel, assembles the snapshot.
- `lib/score.ts` — `deriveMetrics` consolidates best-available values; `computeScores`
  produces both scores with sub-score breakdowns + safety caps.
- `app/api/conditions/[slug]/route.ts` — cached JSON API the pages consume.
- `components/ConditionsDashboard.tsx` — client shell (Surf/Beach Day toggle, SWR polling
  every 5 min, footer).
- `components/HistoryCharts.tsx` + `components/LevelBarChart.tsx` — the by-hour / by-day
  busyness & seaweed charts.

**Conventions:** units normalized to imperial in adapters (`lib/util.ts`); new data source
⇒ new `lib/sources/x.ts` returning `Wrapped<T>` + a fixture-based test.

**Guardrails:** don't embed/scrape Surfline cams (link out only); scores are guidance —
lifeguard flags are the authoritative safety override.

---

## 4. Git branches & remote data branches

| Branch | Purpose |
|---|---|
| `main` | production; Netlify deploys from it |
| `claude/ecstatic-hopper-iRGHU` | **active dev branch** — develop here, then merge to `main` |
| `sargassum-data` | **data branch** — holds `cam_seaweed.json` (seaweed + crowd feed); force-/fast-pushed by the cam-vision Action, NOT part of the app source |
| `lightning-data` | data branch — `lightning.json` from the GOES GLM Action |

The app reads the data branches via raw GitHub URLs (see `lib/sources/sargassum.ts`,
`busyness.ts`, `lightning.ts`). **Do not** hand-edit data branches except for the
controlled republish documented in §6.

**Workflow used all session:** develop on the dev branch → `git merge --no-ff` into `main`
→ push. Pushes to `main` are safe to retry; `origin/main` moves often because scheduled
`eval:` Actions commit there.

---

## 5. The off-Netlify vision pipeline (GitHub Actions)

The seaweed/crowd readings come from beach-cam stills analyzed by a **free vision-API
fallback chain** (`scripts/cam_seaweed.py`): tries providers in order until one answers —
`gemini → groq → openrouter → github` (GitHub Models). Keys are Actions **secrets**:
`GEMINI_API_KEY`, `GROQ_API_KEY`, `OPENROUTER_API_KEY` (+ the job's `GITHUB_TOKEN` with
`models: read`). It runs **off Netlify** so AI calls never touch the host, and publishes
`cam_seaweed.json` to the `sargassum-data` branch.

Free-tier limits that matter: **Gemini ≈250/day & ~10 RPM**, **Groq ≈14,400/day** (token
limits too), **GitHub Models ≈50/day**. For bulk jobs, Groq is the right primary.

| Workflow | What it does |
|---|---|
| `.github/workflows/sargassum.yml` | "Cam Vision Feed" — every ~2h reads seaweed+crowd from the cams, publishes `cam_seaweed.json` to `sargassum-data`. **This is the live, ongoing feed.** |
| `.github/workflows/lightning.yml` | GOES GLM lightning feed → `lightning-data`. |
| `.github/workflows/eval.yml` | "Vision Eval" — archives stills + scores them, commits to `eval/` on `main` for review. |
| `.github/workflows/provider-eval.yml` | per-provider vision accuracy eval. |
| `.github/workflows/backfill-pct.yml` | **one-time, currently dormant** backfill (see §6). |

`eval/` holds the archived stills + `predictions.csv` (model reads) + `manifest.csv`
(capture times). `eval/run_eval.py` scores stills; `eval/backfill_history.py` merges those
reads into `cam_seaweed.json` **with no API calls**.

---

## 6. Session changelog (what was just built)

All merged to `main`. Newest first:

1. **By-day charts → average, not the extreme** (`ce7b845`). Seaweed-by-day was the day's
   *worst* category and busyness-by-day the day's *peak*, so bars looked identical. Both now
   show the **day's average level** (each read uses its measured `cov%`/`crowdPct` when
   present, else its category), sampling-independent, colored by the rounded average. Bar
   height is continuous on the same 0–3 / 0–4 scale as the by-hour charts. Logic in
   `lib/sources/sargassum.ts` & `busyness.ts` (`byDayFromHistory`, `covToRank`/`pctToRank`,
   `readRank`); render in `components/HistoryCharts.tsx` (`avgDayBars`). By-hour charts and
   the "right now" headline summaries deliberately unchanged.

2. **Footer: version + last-updated/build time.** `next.config.mjs` bakes
   `NEXT_PUBLIC_APP_VERSION` (from `package.json`) and `NEXT_PUBLIC_BUILD_TIME` into the
   bundle; `ConditionsDashboard.tsx` shows `v0.1.0 · data updated … · built …`. The
   "data updated" time is the live `snapshot.generatedAt` (ticks with SWR).

3. **Numeric seaweed coverage % + crowd index in scoring** (earlier this session). Seaweed
   and Crowds now score from 0–100 numbers the vision model reads (interpolated through
   calibrated anchors), falling back to categorical bins; weights sum to 1.0, crowds at 5%.

4. **Backfill of historical pct + bug fixes** (see §8 — important caveats).

---

## 7. Open items / next steps

### A. Move to permanent domain — **`isitbeachday.com`** (decided, not yet purchased)
- Name chosen after competitor + RDAP availability research. Avoided collisions: *Shore
  Score*, *Hello Beach*, *Beachday* (a competitor owns beachday.com). The conditions space
  (Surfline, Windy, Buoyweather) doesn't own the friendly "is it a beach day?" angle.
- **Owner is registering it in the Namecheap UI** (privacy ON, auto-renew ON, skip upsells),
  main domain only (no variant).
- **DNS → Netlify plan** (same hosting, just point the domain):
  1. Netlify → site → Domain settings → add `isitbeachday.com` (+ `www`).
  2. At Namecheap, **recommended**: switch nameservers to Netlify DNS (4 `*.nsone.net`
     servers Netlify provides) → auto records + auto HTTPS. *Alternative* (keep Namecheap
     DNS): apex `A @ → 75.2.60.5`, `CNAME www → <site>.netlify.app`.
  3. Netlify auto-issues a Let's Encrypt cert once DNS resolves.
- **No app code changes needed** — verified nothing hardcodes the public URL (`layout.tsx`
  has no `metadataBase`/OG URLs; `manifest.ts` uses relative paths).
- **To finish, the new session needs:** confirmation the domain is registered, the site's
  `*.netlify.app` name, and (optional) a Netlify personal access token to wire it via API.

### B. Rebrand from "Boca Beach Rats" (optional, separate task)
The app scales beyond Boca and you're rebranding to *Is It Beach Day*. Update the title in
`app/layout.tsx` (`title`, `applicationName`, `appleWebApp.title`) and `app/manifest.ts`
(`name`, `short_name`). Small, isolated change — not started.

### C. Historical seaweed/crowd % backfill — **decision: let it fill organically**
No more bulk backfill runs. The 2-hourly cam-vision cron already writes real `cov`/`crowdPct`
going forward; the rolling history (~480 entries, ~1 month) fills in numerically over time.
`backfill-pct.yml` is left **dormant** (only fires if its own file changes).

---

## 8. Gotchas & lessons (so the next session doesn't repeat them)

- **Free-tier quotas are the bottleneck for bulk vision jobs.** Re-scoring all ~168 eval
  stills exhausts Gemini/Groq/GitHub daily limits; doing it repeatedly in one day → mass
  `ERROR`s. If you ever re-run `backfill-pct.yml`: it's **resumable** (`EVAL_BACKFILL_PCT=1`
  re-scores only rows missing pct), runs **Groq-first** with a long timeout (public repo =
  unlimited Actions minutes), and `run_eval.py` no longer clobbers a good category with
  `ERROR` on failure.
- **`backfill_history.py` merge is non-destructive** — it keeps live numeric `cov`/`crowdPct`
  where the eval data lacks them. Any controlled republish: regenerate against the freshest
  `sargassum-data` and **fast-forward push** (don't force-push) to avoid clobbering a
  concurrent cron run.
- **The data branches are force/ff-pushed by Actions** — don't base long-lived work on them.
- **Commit signing can transiently time out** in CI-style environments — just retry the
  commit/push (a small retry loop works).
- **Checking domain availability:** query Verisign RDAP directly for `.com`
  (`https://rdap.verisign.com/com/v1/domain/<name>.com`; 404 = available). `rdap.org`
  cross-host-redirects and won't resolve in one fetch.

---

## 9. Quick reference

```bash
# Dev loop
npm run dev | npm test | npm run lint | npm run build

# Inspect the live seaweed/crowd feed
git show origin/sargassum-data:cam_seaweed.json | python3 -m json.tool | head

# Merge dev → main (the pattern used all session)
git checkout claude/ecstatic-hopper-iRGHU && git merge --ff-only origin/main
git add -A && git commit -m "..." && git push -u origin claude/ecstatic-hopper-iRGHU
git checkout -B main origin/main
git merge --no-ff claude/ecstatic-hopper-iRGHU -m "Merge: ..." && git push -u origin main
```

Repo: `jayfrid-bot/bocabeach` · Host: Netlify · Vision pipeline: GitHub Actions.
