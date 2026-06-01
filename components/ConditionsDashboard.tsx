"use client";

import Link from "next/link";
import useSWR from "swr";
import type { ConditionsResponse } from "@/lib/types";
import { deriveMetrics } from "@/lib/score";
import { scoreColor } from "@/lib/format";
import { ScoreGauge } from "@/components/ScoreGauge";
import { ScoreBreakdown } from "@/components/ScoreBreakdown";
import { MetricCard } from "@/components/MetricCard";
import { WindCompass } from "@/components/WindCompass";
import { TidePanel } from "@/components/TidePanel";
import { SunPanel } from "@/components/SunPanel";
import { SafetyBanner } from "@/components/SafetyBanner";
import { SourceList } from "@/components/SourceBadge";
import { CamGrid } from "@/components/CamGrid";
import { ForecastStrip } from "@/components/ForecastStrip";

const fetcher = (u: string) => fetch(u).then((r) => r.json());

export function ConditionsDashboard({
  slug,
  initial,
}: {
  slug: string;
  initial: ConditionsResponse;
}) {
  const { data } = useSWR<ConditionsResponse>(
    `/api/conditions/${slug}`,
    fetcher,
    { fallbackData: initial, refreshInterval: 300_000 },
  );

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
    snap.sun,
  ];

  return (
    <main className="mx-auto max-w-5xl px-4 py-6 sm:px-6 sm:py-8">
      <header className="mb-6">
        <Link
          href="/"
          className="inline-flex min-h-[36px] items-center text-sm text-ocean-300 hover:underline"
        >
          ← all beaches
        </Link>
        <h1 className="mt-2 text-3xl font-bold text-white sm:text-4xl">
          {snap.location.name}
        </h1>
        <p className="text-slate-400">{snap.location.region}</p>
      </header>

      <div className="mb-6">
        <SafetyBanner city={snap.cityOfficial} />
      </div>

      <section className="mb-6 grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <div className="flex flex-col items-center gap-4 rounded-2xl bg-slate-900/70 p-6 ring-1 ring-white/10">
          <ScoreGauge
            score={active.score}
            rating={active.rating}
            label="Beach Day score"
            accent={scoreColor(active.score)}
          />
          {ratings &&
          (ratings.swimmingRating || ratings.surfingRating || ratings.snorkelingRating) ? (
            <div className="text-center text-xs text-slate-400">
              Lifeguard rating:{" "}
              {[
                ratings.swimmingRating && `swim ${ratings.swimmingRating}`,
                ratings.snorkelingRating && `snorkel ${ratings.snorkelingRating}`,
                ratings.surfingRating && `surf ${ratings.surfingRating}`,
              ]
                .filter(Boolean)
                .join(" · ")}
            </div>
          ) : null}
        </div>
        <ScoreBreakdown result={active} />
      </section>

      <section className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        <div className="rounded-2xl bg-slate-900/70 p-4 ring-1 ring-white/10">
          <div className="flex items-center gap-2 text-sm text-slate-400">
            <span aria-hidden>💨</span>
            <span>Wind</span>
          </div>
          <div className="mt-2">
            <WindCompass fromDeg={d.windDirDeg} speedMph={d.windSpeedMph} />
          </div>
        </div>
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
          icon="☁️"
          label="Cloud cover"
          value={d.cloudCoverPct != null ? `${d.cloudCoverPct}%` : "—"}
          sub={
            d.cloudCoverPct != null
              ? d.cloudCoverPct <= 15
                ? "full sun"
                : d.cloudCoverPct <= 60
                  ? "partly cloudy"
                  : "overcast"
              : undefined
          }
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
          <MetricCard
            icon="🌧️"
            label="Rain chance"
            value={`${d.precipProbability}%`}
          />
        ) : null}
      </section>

      <section className="mb-6 grid gap-4 sm:grid-cols-2">
        <TidePanel tides={snap.tides} tz={tz} />
        <SunPanel sun={snap.sun} tz={tz} />
      </section>

      <section className="mb-8">
        <CamGrid cams={cams} />
      </section>

      <footer className="space-y-3">
        <SourceList sources={sources} />
        <p className="text-center text-xs text-slate-500">
          Composite scores are an automated estimate for general guidance only —
          not a safety determination. Always follow posted flags and lifeguards.
        </p>
      </footer>
    </main>
  );
}
