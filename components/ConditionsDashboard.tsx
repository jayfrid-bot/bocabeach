"use client";

import Link from "next/link";
import useSWR from "swr";
import type { ConditionsResponse } from "@/lib/types";
import { deriveMetrics } from "@/lib/score";
import { TowerDial } from "@/components/TowerDial";
import { ScoreBreakdown } from "@/components/ScoreBreakdown";
import { MetricCard } from "@/components/MetricCard";
import { WindCompass } from "@/components/WindCompass";
import { TidePanel } from "@/components/TidePanel";
import { SafetyBanner } from "@/components/SafetyBanner";
import { SourceList } from "@/components/SourceBadge";
import { CamGrid } from "@/components/CamGrid";
import { ForecastStrip } from "@/components/ForecastStrip";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Surface } from "@/components/ui";

const fetcher = (u: string) => fetch(u).then((r) => r.json());

export function ConditionsDashboard({
  slug,
  initial,
}: {
  slug: string;
  initial: ConditionsResponse;
}) {
  const { data } = useSWR<ConditionsResponse>(`/api/conditions/${slug}`, fetcher, {
    fallbackData: initial,
    refreshInterval: 300_000,
  });

  const res = data ?? initial;
  const snap = res.snapshot;
  const active = res.score;
  const d = deriveMetrics(snap);
  const tz = snap.location.timezone;
  const cams = res.cams;
  const ratings = snap.cityOfficial.data;

  const sources = [
    snap.weather,
    snap.buoy,
    snap.tides,
    snap.marine,
    snap.cityOfficial,
    snap.waterQuality,
    snap.forecast,
  ];

  const lifeguardRating = [
    ratings?.swimmingRating && `swim ${ratings.swimmingRating}`,
    ratings?.snorkelingRating && `snorkel ${ratings.snorkelingRating}`,
    ratings?.surfingRating && `surf ${ratings.surfingRating}`,
  ].filter(Boolean);

  return (
    <main className="min-h-screen pb-12">
      {/* Full-bleed header banner */}
      <header className="tower-banner-tex relative">
        <div className="mx-auto w-full max-w-[var(--maxw)] px-4 pb-24 pt-5 sm:px-6 sm:pb-28">
          <div className="flex items-center justify-between gap-3">
            <Link
              href="/"
              className="inline-flex min-h-[36px] items-center font-head text-sm font-semibold text-ink-soft hover:text-ink"
            >
              ← all beaches
            </Link>
            <ThemeToggle />
          </div>
          <h1 className="mt-3 font-display text-5xl uppercase leading-none tracking-tight text-ink sm:text-6xl">
            {snap.location.name}
          </h1>
          <p className="mt-1 font-head text-sm uppercase tracking-[0.12em] text-ink-soft">
            {snap.location.region}
          </p>
        </div>
      </header>

      <div className="mx-auto -mt-20 w-full max-w-[var(--maxw)] space-y-6 px-4 sm:-mt-24 sm:px-6">
        {/* Hero dial card, overlapping the banner */}
        <Surface className="p-5 sm:p-6">
          <div className="grid items-center gap-6 sm:grid-cols-[auto_1fr]">
            <div className="flex flex-col items-center">
              <div className="mb-1 font-head text-xs font-bold uppercase tracking-[0.12em] text-sea-deep">
                Beach Day score
              </div>
              <TowerDial
                score={active.score}
                rating={active.rating}
                pulseToken={snap.generatedAt}
              />
              {lifeguardRating.length ? (
                <div className="mt-1 text-center text-xs text-ink-faint">
                  Lifeguard: {lifeguardRating.join(" · ")}
                </div>
              ) : null}
            </div>
            <ScoreBreakdown result={active} />
          </div>
        </Surface>

        {/* Safety overrides */}
        <SafetyBanner city={snap.cityOfficial} />

        {/* Conditions grid */}
        <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          <Surface className="p-3.5">
            <div className="flex items-center gap-2 text-ink-soft">
              <span className="text-lg" aria-hidden>
                💨
              </span>
              <span className="truncate font-head text-xs font-semibold uppercase tracking-[0.04em]">
                Wind
              </span>
            </div>
            <div className="mt-2">
              <WindCompass fromDeg={d.windDirDeg} speedMph={d.windSpeedMph} />
            </div>
          </Surface>
          <MetricCard
            icon="🌡️"
            label="Water temp"
            value={d.waterTempF != null ? `${d.waterTempF}°F` : "—"}
          />
          <MetricCard
            icon="☀️"
            label="Air temp"
            value={d.airTempF != null ? `${d.airTempF}°F` : "—"}
            sub={d.shortForecast}
          />
          <MetricCard
            icon="〰️"
            label="Sea state"
            value={d.waveHeightFt != null ? `${d.waveHeightFt} ft` : "—"}
          />
          <MetricCard
            icon="🔆"
            label="UV index"
            value={d.uvIndex != null ? `${d.uvIndex}` : "—"}
          />
          <MetricCard
            icon="🧫"
            label="Water quality"
            value={
              d.waterRating === "unknown"
                ? "—"
                : d.waterRating[0].toUpperCase() + d.waterRating.slice(1)
            }
            sub={d.waterAdvisory ? "advisory in effect" : undefined}
          />
          {d.precipProbability != null ? (
            <MetricCard icon="🌧️" label="Rain chance" value={`${d.precipProbability}%`} />
          ) : null}
        </section>

        {/* 7-day outlook */}
        <ForecastStrip forecast={snap.forecast} />

        {/* Tides */}
        <TidePanel tides={snap.tides} tz={tz} />

        {/* Cams */}
        <CamGrid cams={cams} />

        {/* Sources + disclaimer */}
        <footer className="space-y-3">
          <SourceList sources={sources} />
          <p className="text-center text-xs text-ink-faint">
            The Beach Day score is an automated estimate for general guidance only — not a
            safety determination. Always follow posted flags and lifeguards.
          </p>
        </footer>
      </div>
    </main>
  );
}
