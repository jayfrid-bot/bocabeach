"use client";

import Link from "next/link";
import useSWR from "swr";
import type { ConditionsResponse } from "@/lib/types";
import { bestBeachWindow, deriveMetrics } from "@/lib/score";
import { beachDayVerdict, fmtDate, fmtTime, scoreColor, seaState } from "@/lib/format";
import { Logo } from "@/components/Logo";
import { ThemeToggle } from "@/components/ThemeToggle";
import { ScoreGauge } from "@/components/ScoreGauge";
import { ScoreBreakdown } from "@/components/ScoreBreakdown";
import { ScoreExplainer } from "@/components/ScoreExplainer";
import { PullToRefresh } from "@/components/PullToRefresh";
import { HourlyScoreGraph } from "@/components/HourlyScoreGraph";
import { AirQualityMeter } from "@/components/AirQualityMeter";
import { LightningCard } from "@/components/LightningCard";
import { LifeguardReport } from "@/components/LifeguardReport";
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
import { MoonPanel } from "@/components/MoonPanel";
import { SafetyBanner } from "@/components/SafetyBanner";
import { SandTempPanel } from "@/components/SandTempPanel";
import { sandVerdict } from "@/lib/sandTemp";
import { SourceList } from "@/components/SourceBadge";
import { CamGrid } from "@/components/CamGrid";
import { ForecastStrip } from "@/components/ForecastStrip";

const fetcher = (u: string) => fetch(u).then((r) => r.json());

// Stamped into the bundle at build time (see next.config.mjs) for the footer.
const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? "dev";
const BUILD_TIME = process.env.NEXT_PUBLIC_BUILD_TIME;

/** Plain-English comfort note for a dew point (°F) — the mugginess driver. */
function dewComfort(f?: number): string | undefined {
  if (f == null) return undefined;
  if (f < 55) return "crisp & dry";
  if (f < 60) return "very comfortable";
  if (f < 65) return "comfortable";
  if (f < 70) return "a bit sticky";
  if (f < 75) return "muggy";
  return "oppressive";
}
/** Plain-English note for relative humidity (%). */
function humidityNote(p?: number): string | undefined {
  if (p == null) return undefined;
  if (p < 40) return "dry";
  if (p < 60) return "comfortable";
  if (p < 75) return "humid";
  if (p < 90) return "muggy";
  return "saturated";
}

export function ConditionsDashboard({
  slug,
  initial,
}: {
  slug: string;
  initial: ConditionsResponse;
}) {
  const { data, mutate } = useSWR<ConditionsResponse>(
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
  const traffic = snap.traffic.data;
  const rip = snap.nws.data?.ripCurrentRisk;
  const nc = snap.nowcast.data;
  const bw = bestBeachWindow(res.hourlyScores);
  // Bound the by-hour charts to daylight: local hour of sunrise / sunset.
  const localHour = (iso?: string) => {
    if (!iso) return undefined;
    const h = Number(
      new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", hour12: false }).format(
        new Date(iso),
      ),
    );
    return Number.isFinite(h) ? h % 24 : undefined;
  };
  const sunriseHour = localHour(snap.sun.data?.sunrise);
  const sunsetHour = localHour(snap.sun.data?.sunset);
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
    snap.metno,
    snap.gfs,
    snap.lightning,
    snap.sargassum,
    snap.busyness,
    snap.traffic,
    snap.forecast,
    snap.sun,
    snap.hourly,
  ];

  return (
    <PullToRefresh onRefresh={() => mutate()}>
    <main className="mx-auto max-w-5xl px-4 py-6 sm:px-6 sm:py-8">
      <header className="mb-6">
        <div className="flex items-center justify-between">
          <Link
            href="/"
            className="inline-flex min-h-[36px] items-center text-sm hover:opacity-80"
            aria-label="Is It Beach Day — home"
          >
            <Logo markSize={28} />
          </Link>
          <ThemeToggle />
        </div>
        <h1 className="mt-2 text-3xl font-bold text-slate-900 dark:text-white sm:text-4xl">
          {snap.location.name}
        </h1>
        <p className="text-slate-600 dark:text-slate-400">{snap.location.region}</p>
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
        <div className="flex flex-col items-center gap-4 rounded-2xl bg-white/80 dark:bg-slate-900/70 p-6 ring-1 ring-slate-900/10 dark:ring-white/10">
          <div className="text-center">
            <div className="text-xs uppercase tracking-widest text-slate-500">
              Is it beach day?
            </div>
            <div
              className="text-2xl font-bold"
              style={{ color: scoreColor(active.score) }}
            >
              {beachDayVerdict(active.score)}
            </div>
          </div>
          <ScoreGauge
            score={active.score}
            rating={active.rating}
            label="Beach Day score"
            accent={scoreColor(active.score)}
          />
          {ratings &&
          (ratings.swimmingRating || ratings.surfingRating || ratings.snorkelingRating) ? (
            <div className="text-center text-xs text-slate-600 dark:text-slate-400">
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

      <section className="mb-6">
        <ScoreExplainer derived={d} result={active} />
      </section>

      {nc || bw ? (
        <section className="mb-4 flex flex-wrap gap-2 text-sm">
          {nc ? (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-200/80 dark:bg-slate-800/70 px-3 py-1 text-slate-700 dark:text-slate-200 ring-1 ring-slate-900/10 dark:ring-white/10">
              <span aria-hidden>{nc.state === "raining" ? "🌧️" : "☀️"}</span>
              {nc.text}
            </span>
          ) : null}
          {bw ? (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-200/80 dark:bg-slate-800/70 px-3 py-1 text-slate-700 dark:text-slate-200 ring-1 ring-slate-900/10 dark:ring-white/10">
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
        <div className="rounded-2xl bg-white/80 dark:bg-slate-900/70 p-4 ring-1 ring-slate-900/10 dark:ring-white/10">
          <div className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400">
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
          icon="💧"
          label="Humidity"
          value={d.humidityPct != null ? `${d.humidityPct}%` : "—"}
          sub={humidityNote(d.humidityPct)}
        />
        <MetricCard
          icon="🌫️"
          label="Dew point"
          value={d.dewPointF != null ? `${d.dewPointF}°F` : "—"}
          sub={dewComfort(d.dewPointF)}
        />
        <MetricCard
          icon="〰️"
          label="Sea state"
          value={
            d.waveHeightFt != null
              ? `${d.waveHeightFt} ft · ${seaState(d.waveHeightFt).label}`
              : "—"
          }
          sub={d.waveHeightFt != null ? seaState(d.waveHeightFt).note : undefined}
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
          icon="🦶"
          label="Sand temp (est.)"
          value={d.sandTempF != null ? `~${d.sandTempF}°F` : "—"}
          sub={d.sandTempF != null ? sandVerdict(d.sandTempF).advice : undefined}
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
          label="Seaweed (sargassum)"
          value={!sg || sg.level === "unknown" ? "—" : cap(sg.level)}
          sub={
            sg
              ? `📷 ${sg.isMorning ? "AM cams (pre-clean)" : "cams"}` +
                (sg.coveragePct != null ? ` · ~${sg.coveragePct}% covered` : "") +
                (sg.note ? ` — ${sg.note}` : "")
              : undefined
          }
        />
        <MetricCard
          icon="👥"
          label="Beach busyness"
          value={!busy || busy.level === "unknown" ? "—" : cap(busy.level)}
          sub={
            busy && busy.level !== "unknown"
              ? [
                  busy.peopleEstimate != null ? `~${busy.peopleEstimate} people` : busy.note,
                  busy.crowdPct != null ? `~${busy.crowdPct}% full` : undefined,
                ]
                  .filter(Boolean)
                  .join(" · ") || undefined
              : undefined
          }
        />
        <MetricCard
          icon="🚗"
          label="Traffic"
          value={!traffic || traffic.level === "unknown" ? "—" : cap(traffic.level)}
          sub={
            traffic && traffic.level !== "unknown"
              ? traffic.congestion != null
                ? `${traffic.congestion}% congestion near the beach`
                : "near the beach"
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

      {snap.hourly.data?.length ? (
        <section className="mb-6">
          <SandTempPanel
            hours={snap.hourly.data}
            sunriseIso={snap.sun.data?.sunrise}
            sunsetIso={snap.sun.data?.sunset}
            tz={tz}
          />
        </section>
      ) : null}

      <section className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <AirQualityMeter air={snap.airQuality} />
        <LightningCard lightning={snap.lightning} />
        <LifeguardReport city={snap.cityOfficial} />
      </section>

      {busy?.byHour?.length ||
      busy?.byDay?.length ||
      sg?.byHour?.length ||
      sg?.byDay?.length ? (
        <section className="mb-6 grid gap-6 lg:grid-cols-2">
          {busy?.byHour?.length ? (
            <BusynessByHourChart
              byHour={busy.byHour}
              tz={tz}
              sunriseHour={sunriseHour}
              sunsetHour={sunsetHour}
            />
          ) : null}
          {busy?.byDay?.length ? <BusynessByDayChart byDay={busy.byDay} tz={tz} /> : null}
          {sg?.byHour?.length ? (
            <SeaweedByHourChart
              byHour={sg.byHour}
              tz={tz}
              sunriseHour={sunriseHour}
              sunsetHour={sunsetHour}
            />
          ) : null}
          {sg?.byDay?.length ? <SeaweedByDayChart byDay={sg.byDay} tz={tz} /> : null}
        </section>
      ) : null}

      <section className="mb-6 grid gap-4 sm:grid-cols-2">
        <TidePanel tides={snap.tides} tz={tz} />
        <SunPanel sun={snap.sun} tz={tz} />
        <MoonPanel sun={snap.sun} />
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
        <p className="text-center text-xs text-slate-500">
          Spot something off or have an idea?{" "}
          <a
            href="mailto:hello@isitbeachday.com"
            className="text-ocean-700 dark:text-ocean-300 hover:underline"
          >
            hello@isitbeachday.com
          </a>
        </p>
        <p className="text-center text-xs text-slate-500">
          v{APP_VERSION}
          <span className="mx-1.5 text-slate-400 dark:text-slate-600">·</span>
          data updated {fmtDate(snap.generatedAt, tz)}, {fmtTime(snap.generatedAt, tz)}
          {BUILD_TIME && (
            <>
              <span className="mx-1.5 text-slate-400 dark:text-slate-600">·</span>
              built {fmtDate(BUILD_TIME, tz)}, {fmtTime(BUILD_TIME, tz)}
            </>
          )}
        </p>
      </footer>
    </main>
    </PullToRefresh>
  );
}
