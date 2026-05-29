"use client";

import Link from "next/link";
import { useState } from "react";
import useSWR from "swr";
import type { ConditionsResponse } from "@/lib/types";
import { deriveMetrics } from "@/lib/score";
import { scoreColor } from "@/lib/format";
import { ScoreGauge } from "@/components/ScoreGauge";
import { ScoreToggle, type ScoreMode } from "@/components/ScoreToggle";
import { ScoreBreakdown } from "@/components/ScoreBreakdown";
import { MetricCard } from "@/components/MetricCard";
import { WindCompass } from "@/components/WindCompass";
import { TidePanel } from "@/components/TidePanel";
import { SafetyBanner } from "@/components/SafetyBanner";
import { SourceList } from "@/components/SourceBadge";
import { CamGrid } from "@/components/CamGrid";

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
  const [mode, setMode] = useState<ScoreMode>("beachDay");

  const res = data ?? initial;
  const snap = res.snapshot;
  const active = mode === "beachDay" ? res.scores.beachDay : res.scores.surf;
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
  ];

  return (
    <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
      <header className="mb-6">
        <Link href="/" className="text-sm text-ocean-300 hover:underline">
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
          <ScoreToggle mode={mode} onChange={setMode} />
          <ScoreGauge
            score={active.score}
            rating={active.rating}
            label={mode === "beachDay" ? "Beach Day score" : "Surf score"}
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
          icon="🏄"
          label="Swell"
          value={d.surfHeightFt != null ? `${d.surfHeightFt} ft` : "—"}
          sub={d.surfPeriodS != null ? `${d.surfPeriodS}s period` : undefined}
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
          <MetricCard
            icon="🌧️"
            label="Rain chance"
            value={`${d.precipProbability}%`}
          />
        ) : null}
      </section>

      <section className="mb-6 grid gap-4 lg:grid-cols-2">
        <TidePanel tides={snap.tides} tz={tz} />
        <div className="lg:col-span-2">
          <CamGrid cams={cams} />
        </div>
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
