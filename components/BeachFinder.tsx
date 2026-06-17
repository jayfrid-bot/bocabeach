"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import type { LocationPublic } from "@/lib/types";
import { US_STATE_NAMES, stateCodeFromRegion } from "@/lib/stateBeachPrograms";

/** Great-circle distance in miles between two lat/lon points. */
function distMi(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 3958.8;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

type GeoState = "idle" | "locating" | "denied" | "unsupported";

function BeachCard({ b, miles }: { b: LocationPublic; miles?: number }) {
  return (
    <Link
      href={`/${b.slug}`}
      className="group flex items-center justify-between gap-3 rounded-xl bg-white/80 px-4 py-3 ring-1 ring-slate-900/10 transition hover:ring-amber-400/40 dark:bg-slate-900/70 dark:ring-white/10"
    >
      <div className="min-w-0">
        <div className="truncate font-medium text-slate-900 dark:text-white">{b.name}</div>
        <div className="truncate text-xs text-slate-500">{b.region}</div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {miles != null ? (
          <span className="rounded-full bg-ocean-500/10 px-2 py-0.5 text-[11px] font-medium text-ocean-700 dark:text-ocean-300">
            {miles < 10 ? miles.toFixed(1) : Math.round(miles)} mi
          </span>
        ) : null}
        <span className="text-slate-400 transition group-hover:text-amber-400">→</span>
      </div>
    </Link>
  );
}

export function BeachFinder({ beaches }: { beaches: LocationPublic[] }) {
  const [q, setQ] = useState("");
  const [origin, setOrigin] = useState<{ lat: number; lon: number } | null>(null);
  const [geo, setGeo] = useState<GeoState>("idle");

  const locate = () => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setGeo("unsupported");
      return;
    }
    setGeo("locating");
    navigator.geolocation.getCurrentPosition(
      (p) => {
        setOrigin({ lat: p.coords.latitude, lon: p.coords.longitude });
        setGeo("idle");
      },
      () => setGeo("denied"),
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 600_000 },
    );
  };

  const needle = q.trim().toLowerCase();

  // Flat, ranked list for search and "nearest to me"; null distance = not ranked.
  const ranked = useMemo(() => {
    let list = beaches;
    if (needle) {
      list = list.filter((b) => `${b.name} ${b.region}`.toLowerCase().includes(needle));
    }
    if (origin) {
      return list
        .map((b) => ({ b, mi: distMi(origin.lat, origin.lon, b.lat, b.lon) }))
        .sort((x, y) => x.mi - y.mi);
    }
    return list.map((b) => ({ b, mi: null as number | null }));
  }, [beaches, needle, origin]);

  // Browse-by-state grouping, used only when there's no query and no location.
  const byState = useMemo(() => {
    const groups = new Map<string, LocationPublic[]>();
    for (const b of beaches) {
      const code = stateCodeFromRegion(b.region) ?? "ZZ";
      const arr = groups.get(code) ?? [];
      arr.push(b);
      groups.set(code, arr);
    }
    return [...groups.entries()]
      .map(([code, list]) => ({
        code,
        name: US_STATE_NAMES[code] ?? "Other",
        list: list.sort((a, b) => a.name.localeCompare(b.name)),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [beaches]);

  const browse = !needle && !origin;

  return (
    <div>
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search a beach or town…"
          aria-label="Search beaches"
          className="min-h-[44px] flex-1 rounded-full bg-white/80 px-5 text-sm text-slate-900 ring-1 ring-slate-900/10 placeholder:text-slate-400 dark:bg-slate-900/70 dark:text-white dark:ring-white/10"
        />
        <button
          type="button"
          onClick={locate}
          className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-full bg-ocean-600 px-5 text-sm font-medium text-white transition hover:bg-ocean-500 disabled:opacity-60"
          disabled={geo === "locating"}
        >
          📍 {geo === "locating" ? "Locating…" : origin ? "Nearest to you" : "Use my location"}
        </button>
      </div>

      {geo === "denied" ? (
        <p className="mt-2 text-xs text-slate-500">
          Couldn&apos;t get your location — search by name instead.
        </p>
      ) : null}
      {geo === "unsupported" ? (
        <p className="mt-2 text-xs text-slate-500">
          Location isn&apos;t available on this device — search by name instead.
        </p>
      ) : null}
      {origin ? (
        <div className="mt-2 flex items-center gap-2 text-xs text-slate-500">
          <span>Showing beaches nearest to you.</span>
          <button
            type="button"
            onClick={() => setOrigin(null)}
            className="underline hover:text-slate-700 dark:hover:text-slate-300"
          >
            Clear
          </button>
        </div>
      ) : null}

      {/* Browse-by-state (default) */}
      {browse ? (
        <div className="mt-5 space-y-6">
          {byState.map((g) => (
            <section key={g.code}>
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                {g.name}
              </h2>
              <div className="grid gap-2 sm:grid-cols-2">
                {g.list.map((b) => (
                  <BeachCard key={b.slug} b={b} />
                ))}
              </div>
            </section>
          ))}
        </div>
      ) : (
        <div className="mt-5">
          {ranked.length === 0 ? (
            <div className="rounded-xl bg-white/80 p-5 text-center text-sm text-slate-600 ring-1 ring-slate-900/10 dark:bg-slate-900/70 dark:text-slate-400 dark:ring-white/10">
              No beach matches “{q}” yet.{" "}
              <a
                href={`mailto:hello@isitbeachday.com?subject=${encodeURIComponent(
                  "Add a beach: " + q,
                )}`}
                className="text-ocean-700 underline dark:text-ocean-300"
              >
                Request it →
              </a>
            </div>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2">
              {ranked.map(({ b, mi }) => (
                <BeachCard key={b.slug} b={b} miles={mi ?? undefined} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
