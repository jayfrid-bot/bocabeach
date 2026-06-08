"use client";

import Link from "next/link";
import useSWR from "swr";
import type { ConditionsResponse } from "@/lib/types";
import { bestBeachWindow, deriveMetrics } from "@/lib/score";
import { fmtTime, scoreColor } from "@/lib/format";
import { ScoreGauge } from "@/components/ScoreGauge";
import { ScoreBreakdown } from "@/components/ScoreBreakdown";
import { HourlyScoreGraph } from "@/components/HourlyScoreGraph";
import { AirQualityMeter } from "@/components/AirQualityMeter";
import { LightningCard } from "@/components/LightningCard";
import {
  BusynessByHourChart,
  BusynessByDayChart,
  SeaweedByHourChart,
  SeaweedByDayChart,
} from "@/components/HistoryCharts";
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
  const sg = snap.sargassum.data;
  const busy = snap.busyness.data;
  const rip = snap.nws.data?.ripCurrentRisk;
  const nc = snap.nowcast.data;
  const bw = bestBeachWindow(res.hourlyScores);
  const uvBurn =
    d.uvIndex != null && d.uvIndex >= 1 ? Math.round(200 / d.uvIndex) : undefined;
  const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

  const sources = [
    snap.weather,
    snap.buoy,
    snap.tides,
    snap.marine,
    snap.cityOfficial,
    snap.waterQuality,
    snap.nowcast,
    snap.nws,
    snap.airQuality,
    snap.lightning,
    snap.sargassum,
    snap.busyness,
    snap.forecast,
    snap.sun,
    snap.hourly,
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
        <SafetyBanner
          city={snap.cityOfficial}
          water={snap.waterQuality}
          lightning={snap.lightning}
          nws={snap.nws}
        />
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

      {nc || bw ? (
        <section className="mb-4 flex flex-wrap gap-2 text-sm">
          {nc ? (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-800/70 px-3 py-1 text-slate-200 ring-1 ring-white/10">
              <span aria-hidden>{nc.state === "raining" ? "🌧️" : "☀️"}</span>
              {nc.text}
            </span>
          ) : null}
          {bw ? (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-800/70 px-3 py-1 text-slate-200 ring-1 ring-white/10">
              <span aria-hidden>⭐</span>
              Best window today: {fmtTime(bw.startIso, tz)}–{fmtTime(bw.endIso, tz)}
            </span>
          ) : null}
        </section>
      ) : null}

      <section className="mb-6">
        <HourlyScoreGraph hours={res.hourlyScores} tz={tz} />
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
          sub={
            uvBurn != null
              ? `~${uvBurn} min to burn`
              : d.uvIndex != null
                ? "minimal burn risk"
                : undefined
          }
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
        <MetricCard
          icon="🪸"
          label="Sargassum (seaweed)"
          value={!sg || sg.level === "unknown" ? "—" : cap(sg.level)}
          sub={
            sg
              ? `📷 ${sg.isMorning ? "AM cams (pre-clean)" : "cams"}${sg.note ? " — " + sg.note : ""}`
              : undefined
          }
        />
        <MetricCard
          icon="👥"
          label="Beach busyness"
          value={!busy || busy.level === "unknown" ? "—" : cap(busy.level)}
          sub={
            busy && busy.level !== "unknown"
              ? busy.peopleEstimate != null
                ? `~${busy.peopleEstimate} people in view`
                : busy.note
              : undefined
          }
        />
        <MetricCard
          icon="🌊"
          label="Rip current risk"
          value={!rip || rip === "unknown" ? "—" : cap(rip)}
          sub={rip && rip !== "unknown" ? "NWS Surf Zone Forecast" : undefined}
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
        <AirQualityMeter air={snap.airQuality} />
        <LightningCard lightning={snap.lightning} />
      </section>

      {busy?.byHour?.length ||
      busy?.byDay?.length ||
      sg?.byHour?.length ||
      sg?.byDay?.length ? (
        <section className="mb-6 grid gap-6 lg:grid-cols-2">
          {busy?.byHour?.length ? (
            <BusynessByHourChart byHour={busy.byHour} tz={tz} />
          ) : null}
          {busy?.byDay?.length ? <BusynessByDayChart byDay={busy.byDay} tz={tz} /> : null}
          {sg?.byHour?.length ? <SeaweedByHourChart byHour={sg.byHour} tz={tz} /> : null}
          {sg?.byDay?.length ? <SeaweedByDayChart byDay={sg.byDay} tz={tz} /> : null}
        </section>
      ) : null}

      <section className="mb-6 grid gap-4 sm:grid-cols-2">
        <TidePanel tides={snap.tides} tz={tz} />
        <SunPanel sun={snap.sun} tz={tz} />
      </section>

      <section className="mb-8">
        <CamGrid cams={cams} tz={tz} />
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
