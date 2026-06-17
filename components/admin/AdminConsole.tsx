"use client";

import { useCallback, useState } from "react";
import type { ConditionsResponse, Location } from "@/lib/types";
import { ConditionsDashboard } from "@/components/ConditionsDashboard";
import { ThemeToggle } from "@/components/ThemeToggle";

interface Candidate {
  name: string;
  lat: number;
  lon: number;
  state?: string;
  distanceMi: number;
}
interface WarningItem {
  code: string;
  message: string;
  severity: string;
}
interface ResolveApi {
  status: "resolved" | "pick-list" | "rejected";
  candidates: Candidate[];
  warnings: WarningItem[];
  snippet?: string;
  report: string;
  location?: Location;
}
interface AddApi {
  ok: boolean;
  dryRun?: boolean;
  reason?: string;
  slug?: string;
  commitUrl?: string;
  count?: number;
  preview?: string;
  message?: string;
}

const card = "rounded-2xl bg-white/80 dark:bg-slate-900/70 p-5 ring-1 ring-slate-900/10 dark:ring-white/10";
const btn =
  "inline-flex min-h-[40px] items-center justify-center rounded-full px-4 text-sm font-medium transition disabled:opacity-50";
const btnPrimary = `${btn} bg-ocean-600 text-white hover:bg-ocean-500`;
const btnGhost = `${btn} bg-slate-900/5 text-slate-700 ring-1 ring-slate-900/10 hover:bg-slate-900/10 dark:bg-white/5 dark:text-slate-200 dark:ring-white/10 dark:hover:bg-white/10`;

export function AdminConsole() {
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ResolveApi | null>(null);
  // An editable copy of the resolved Location (name / region / slug are tweakable).
  const [loc, setLoc] = useState<Location | null>(null);

  const [preview, setPreview] = useState<ConditionsResponse | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [add, setAdd] = useState<AddApi | null>(null);
  const [addBusy, setAddBusy] = useState(false);

  const runResolve = useCallback(
    async (q: string, pick?: number) => {
      setBusy(true);
      setError(null);
      setPreview(null);
      setAdd(null);
      try {
        const url = `/api/resolve?q=${encodeURIComponent(q)}${pick !== undefined ? `&pick=${pick}` : ""}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`resolve failed (${res.status})`);
        const data: ResolveApi = await res.json();
        setResult(data);
        setLoc(data.location ? { ...data.location } : null);
      } catch (e) {
        setError(String(e));
        setResult(null);
        setLoc(null);
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const runPreview = useCallback(async () => {
    if (!loc) return;
    setPreviewBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ location: loc }),
      });
      if (!res.ok) throw new Error(`preview failed (${res.status})`);
      setPreview(await res.json());
    } catch (e) {
      setError(String(e));
    } finally {
      setPreviewBusy(false);
    }
  }, [loc]);

  const runAdd = useCallback(
    async (dryRun: boolean) => {
      if (!loc) return;
      if (!dryRun && !window.confirm(`Commit "${loc.name}" (${loc.slug}) to the repo and deploy?`)) return;
      setAddBusy(true);
      setError(null);
      try {
        const res = await fetch(`/api/admin/add${dryRun ? "?dryRun=1" : ""}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ location: loc }),
        });
        setAdd(await res.json());
      } catch (e) {
        setError(String(e));
      } finally {
        setAddBusy(false);
      }
    },
    [loc],
  );

  const setField = (k: "name" | "region" | "slug", v: string) =>
    setLoc((cur) => (cur ? { ...cur, [k]: v } : cur));

  return (
    <main className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Admin · Add a beach</h1>
          <p className="text-sm text-slate-600 dark:text-slate-400">
            Resolve a city or beach name, preview the live dashboard, then commit it.
          </p>
        </div>
        <ThemeToggle />
      </header>

      {/* Search */}
      <form
        className="mb-5 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (query.trim()) runResolve(query.trim());
        }}
      >
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="e.g. Cocoa Beach, Galveston, Outer Banks…"
          className="min-h-[40px] flex-1 rounded-full bg-white/80 px-4 text-sm text-slate-900 ring-1 ring-slate-900/10 placeholder:text-slate-400 dark:bg-slate-900/70 dark:text-white dark:ring-white/10"
        />
        <button type="submit" className={btnPrimary} disabled={busy || !query.trim()}>
          {busy ? "Resolving…" : "Resolve"}
        </button>
      </form>

      {error ? (
        <div className="mb-4 rounded-xl bg-rose-500/10 px-4 py-2 text-sm text-rose-700 ring-1 ring-rose-500/30 dark:text-rose-300">
          {error}
        </div>
      ) : null}

      {/* Pick-list */}
      {result?.status === "pick-list" ? (
        <section className={`${card} mb-5`}>
          <h2 className="mb-1 text-sm font-medium text-slate-700 dark:text-slate-300">
            Multiple matches — pick one
          </h2>
          <div className="mt-2 flex flex-wrap gap-2">
            {result.candidates.map((c, i) => (
              <button key={`${c.name}-${i}`} className={btnGhost} onClick={() => runResolve(query.trim(), i)}>
                {c.name}
                {c.state ? `, ${c.state}` : ""} · {c.distanceMi}mi
              </button>
            ))}
          </div>
        </section>
      ) : null}

      {/* Rejected */}
      {result?.status === "rejected" ? (
        <section className={`${card} mb-5`}>
          <h2 className="text-sm font-medium text-rose-700 dark:text-rose-300">Not a usable beach</h2>
          <ul className="mt-1 text-sm text-slate-600 dark:text-slate-400">
            {result.warnings.map((w) => (
              <li key={w.code}>⚠ {w.message}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* Resolved */}
      {result?.status === "resolved" && loc ? (
        <section className={`${card} mb-5`}>
          <h2 className="mb-3 text-sm font-medium text-slate-700 dark:text-slate-300">Resolved config</h2>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-xs text-slate-500">
              Name
              <input
                value={loc.name}
                onChange={(e) => setField("name", e.target.value)}
                className="mt-1 block w-full rounded-lg bg-white/80 px-2 py-1.5 text-sm text-slate-900 ring-1 ring-slate-900/10 dark:bg-slate-800 dark:text-white dark:ring-white/10"
              />
            </label>
            <label className="text-xs text-slate-500">
              Region
              <input
                value={loc.region}
                onChange={(e) => setField("region", e.target.value)}
                className="mt-1 block w-full rounded-lg bg-white/80 px-2 py-1.5 text-sm text-slate-900 ring-1 ring-slate-900/10 dark:bg-slate-800 dark:text-white dark:ring-white/10"
              />
            </label>
            <label className="text-xs text-slate-500">
              Slug
              <input
                value={loc.slug}
                onChange={(e) => setField("slug", e.target.value)}
                className="mt-1 block w-full rounded-lg bg-white/80 px-2 py-1.5 font-mono text-sm text-slate-900 ring-1 ring-slate-900/10 dark:bg-slate-800 dark:text-white dark:ring-white/10"
              />
            </label>
          </div>

          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-slate-600 dark:text-slate-400 sm:grid-cols-3">
            <div>lat/lon: {loc.lat.toFixed(4)}, {loc.lon.toFixed(4)}</div>
            <div>tz: {loc.timezone || "—"}</div>
            <div>tide: {loc.noaaTideStationId || "—"}{loc.noaaTideStationFallbackId ? ` / ${loc.noaaTideStationFallbackId}` : ""}</div>
            <div>buoy: {loc.ndbcBuoyId || "—"}{loc.ndbcBuoyFallbackId ? ` / ${loc.ndbcBuoyFallbackId}` : ""}</div>
            <div>surf zone: {loc.surfZone ? `${loc.surfZone.office} · ${loc.surfZone.name}` : "—"}</div>
            <div>cams: {loc.cams.length} (owner-curated)</div>
          </dl>

          {result.report ? (
            <pre className="mt-3 max-h-56 overflow-auto rounded-lg bg-slate-900/5 p-3 text-[11px] leading-snug text-slate-700 dark:bg-black/30 dark:text-slate-300">
              {result.report}
            </pre>
          ) : null}

          <div className="mt-4 flex flex-wrap gap-2">
            <button className={btnPrimary} onClick={runPreview} disabled={previewBusy}>
              {previewBusy ? "Loading preview…" : "Preview dashboard"}
            </button>
            <button className={btnGhost} onClick={() => runAdd(true)} disabled={addBusy}>
              Dry-run add
            </button>
            <button className={btnGhost} onClick={() => runAdd(false)} disabled={addBusy}>
              {addBusy ? "Committing…" : "Add → commit & deploy"}
            </button>
          </div>

          {add ? (
            <div
              className={`mt-3 rounded-xl px-4 py-2 text-sm ring-1 ${
                add.ok
                  ? "bg-emerald-500/10 text-emerald-700 ring-emerald-500/30 dark:text-emerald-300"
                  : "bg-rose-500/10 text-rose-700 ring-rose-500/30 dark:text-rose-300"
              }`}
            >
              {add.ok && add.dryRun ? (
                <>
                  Dry run OK — would commit <code>{add.message}</code> ({add.count} generated total).
                </>
              ) : add.ok ? (
                <>
                  Committed ✓ — deploying (~1–2 min).{" "}
                  {add.commitUrl ? (
                    <a className="underline" href={add.commitUrl} target="_blank" rel="noreferrer">
                      view commit
                    </a>
                  ) : null}{" "}
                  Then live at <code>/{add.slug}</code>.
                </>
              ) : (
                <>Add failed: {add.reason}</>
              )}
            </div>
          ) : null}
        </section>
      ) : null}

      {/* Live preview */}
      {preview ? (
        <section className="mb-5">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-medium text-slate-700 dark:text-slate-300">
              Live preview — {loc?.name}
            </h2>
            <button className={btnGhost} onClick={() => setPreview(null)}>
              Close preview
            </button>
          </div>
          <div className="rounded-2xl ring-1 ring-slate-900/10 dark:ring-white/10">
            <ConditionsDashboard slug={loc?.slug ?? "preview"} initial={preview} preview />
          </div>
        </section>
      ) : null}
    </main>
  );
}
