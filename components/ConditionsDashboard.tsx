"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import useSWR from "swr";
import type { ConditionsResponse } from "@/lib/types";
import { deriveMetrics } from "@/lib/score";
import { beachDayVerdict, fmtDate, fmtTime, scoreColor, scoreTextClass, seaState } from "@/lib/format";
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
import { LocalCoverage } from "@/components/LocalCoverage";
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
import { currentSandRangeF, sandVerdict } from "@/lib/sandTemp";
import { SourceList } from "@/components/SourceBadge";
import { CamGrid } from "@/components/CamGrid";
import { ForecastStrip } from "@/components/ForecastStrip";
import { BestTimesStrip } from "@/components/BestTimesStrip";
import { NotifyButton } from "@/components/NotifyButton";

// Throw on non-OK so an error body (e.g. a 404 `{error}`) never replaces the
// good snapshot — SWR keeps the last good data and the consumer guard holds.
const fetcher = (u: string) =>
  fetch(u).then((r) => {
    if (!r.ok) throw new Error(String(r.status));
    return r.json();
  });

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
  preview = false,
  browseHref,
}: {
  slug: string;
  initial: ConditionsResponse;
  /**
   * Admin preview: render `initial` only — disable SWR refetch + auto-refresh
   * (there's no `/api/conditions/<slug>` for a not-yet-configured beach).
   */
  preview?: boolean;
  /**
   * When set, show a small "＋ Other beaches" link to the national picker. Used
   * on the homepage (which stays the flagship beach) and on each beach page.
   */
  browseHref?: string;
}) {
  const { data, mutate, isValidating } = useSWR<ConditionsResponse>(
    preview ? null : `/api/conditions/${slug}`,
    fetcher,
    { fallbackData: initial, refreshInterval: preview ? 0 : 300_000 },
  );

  // Fall back to the SSR snapshot unless SWR has a fully-formed response — an
  // error body lacking `.snapshot` must never shadow the good initial data.
  const res = data && data.snapshot ? data : initial;
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

  // Post-mount wall clock. Read INSIDE the effect (never during render) so SSR
  // and the first client render agree (nowMs === null → full day, no filter).
  // Ticks each minute so time-sensitive readouts (best window, sand temp) stay
  // current — and the sand card stays in lockstep with SandTempPanel's clock.
  const [nowMs, setNowMs] = useState<number | null>(null);
  useEffect(() => {
    setNowMs(Date.now());
    const id = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  // "Best window today" pill — reuse the server-computed Today window from
  // multiDayWindows[0] so the pill and the Best-times strip always show the SAME
  // window (a client recompute used different daylight bounds + a different clock).
  const bw = res.multiDayWindows?.[0]?.best ?? null;
  // Current sand range from the shared helper (same hour bucket as the score +
  // the SandTempPanel). Null until mounted, so SSR/first render show "—".
  const sandRange = nowMs != null ? currentSandRangeF(snap.hourly.data ?? [], nowMs) : null;

  // Single, stable handler shared by pull-to-refresh and the visible button.
  const onRefresh = useCallback(() => mutate(), [mutate]);

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
    <PullToRefresh onRefresh={onRefresh}>
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
        {snap.location.tier === "auto" ? (
          <span className="mt-2 inline-flex items-center gap-1 rounded-full bg-ocean-500/10 px-2.5 py-0.5 text-[11px] font-medium text-ocean-700 ring-1 ring-ocean-500/20 dark:text-ocean-300">
            ✨ Auto-resolved · core conditions live, some local data pending
          </span>
        ) : null}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {browseHref ? (
            <Link
              href={browseHref}
              className="inline-flex items-center gap-1.5 rounded-full bg-ocean-500/10 px-3 py-1 text-xs font-medium text-ocean-700 ring-1 ring-ocean-500/20 transition hover:bg-ocean-500/20 dark:text-ocean-300"
            >
              <span aria-hidden className="text-sm leading-none">＋</span> Other beaches
            </Link>
          ) : null}
          {!preview ? <NotifyButton slug={slug} /> : null}
        </div>
      </header>

      <div className="mb-6">
        <SafetyBanner
          city={snap.cityOfficial}
          water={snap.waterQuality}
          lightning={snap.lightning}
          nws={snap.nws}
          timezone={snap.location.timezone}
        />
      </div>

      <section className="mb-6 grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <div className="flex flex-col items-center gap-4 rounded-2xl bg-white/80 dark:bg-slate-900/70 p-6 ring-1 ring-slate-900/10 dark:ring-white/10">
          {active.dataAvailable === false ? (
            // Total data outage: every sub-score was unavailable, so a confident
            // 0 / "Not really" would be misleading. Say so plainly instead.
            <div className="flex flex-col items-center gap-2 py-8 text-center">
              <span aria-hidden className="text-3xl">
                📡
              </span>
              <div className="text-xl font-bold text-slate-900 dark:text-white">
                Conditions unavailable
              </div>
              <div className="text-sm text-slate-600 dark:text-slate-400">
                We could not reach the data sources right now. Try refreshing in
                a few minutes.
              </div>
            </div>
          ) : (
            <>
              {/* Verdict word is the headline; the gauge number supports it. */}
              <div
                className={`text-3xl font-bold ${scoreTextClass(active.score)}`}
              >
                {beachDayVerdict(active.score)}
              </div>
              <ScoreGauge
                score={active.score}
                rating={active.rating}
                label="Beach Day score"
                accent={scoreColor(active.score)}
              />
              {ratings &&
              (ratings.swimmingRating ||
                ratings.surfingRating ||
                ratings.snorkelingRating) ? (
                <div className="text-center text-xs text-slate-600 dark:text-slate-400">
                  Lifeguard rating:{" "}
                  {[
                    ratings.swimmingRating && `swim ${ratings.swimmingRating}`,
                    ratings.snorkelingRating &&
                      `snorkel ${ratings.snorkelingRating}`,
                    ratings.surfingRating && `surf ${ratings.surfingRating}`,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </div>
              ) : null}
            </>
          )}
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
              Best remaining window today: {fmtTime(bw.startIso, tz)}–{fmtTime(bw.endIso, tz)}
            </span>
          ) : null}
        </section>
      ) : null}

      <section className="mb-6">
        <HourlyScoreGraph hours={res.hourlyScores} tz={tz} />
      </section>

      {res.multiDayWindows?.length ? (
        <section className="mb-6">
          <BestTimesStrip days={res.multiDayWindows} tz={tz} />
        </section>
      ) : null}

      <section className="mb-6">
        <ForecastStrip forecast={snap.forecast} />
      </section>

      <h2 className="mb-3 mt-2 text-lg font-semibold text-slate-900 dark:text-white">
        Explore the details
      </h2>

      <section className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        <div className="col-span-2 rounded-2xl bg-white/80 dark:bg-slate-900/70 p-4 ring-1 ring-slate-900/10 dark:ring-white/10 sm:col-span-1">
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
          sub={d.waterTempF == null ? "not available" : undefined}
        />
        <MetricCard
          icon="☀️"
          label="Air temp"
          value={d.airTempF != null ? `${d.airTempF}°F` : "—"}
          sub={d.airTempF != null ? d.shortForecast : "not available"}
        />
        <MetricCard
          icon="💧"
          label="Humidity"
          value={d.humidityPct != null ? `${d.humidityPct}%` : "—"}
          sub={d.humidityPct != null ? humidityNote(d.humidityPct) : "not available"}
        />
        <MetricCard
          icon="🌫️"
          label="Dew point"
          value={d.dewPointF != null ? `${d.dewPointF}°F` : "—"}
          sub={d.dewPointF != null ? dewComfort(d.dewPointF) : "not available"}
        />
        <MetricCard
          icon="〰️"
          label="Sea state"
          value={
            d.waveHeightFt != null
              ? `${d.waveHeightFt} ft · ${seaState(d.waveHeightFt).label}`
              : "—"
          }
          sub={
            d.waveHeightFt != null ? seaState(d.waveHeightFt).note : "not available"
          }
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
                : "not available"
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
              : "not available"
          }
        />
        <MetricCard
          icon="🦶"
          label="Sand temp (est.)"
          // Show the surf–dunes range from the SAME helper the SandTempPanel uses,
          // so the two never disagree. Verdict tracks the dunes (hottest) end.
          value={
            sandRange
              ? sandRange.surfF !== sandRange.dunesF
                ? `~${sandRange.surfF}–${sandRange.dunesF}°F`
                : `~${sandRange.dunesF}°F`
              : "—"
          }
          sub={
            sandRange ? sandVerdict(sandRange.dunesF).advice : "not available"
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
          sub={
            d.waterRating === "unknown"
              ? "not available"
              : d.waterAdvisory
                ? "advisory in effect"
                : undefined
          }
        />
        <MetricCard
          icon="🪸"
          label="Seaweed (sargassum)"
          value={!sg || sg.level === "unknown" ? "—" : cap(sg.level)}
          sub={
            sg && sg.level !== "unknown"
              ? `📷 ${sg.isMorning ? "AM cams (pre-clean)" : "cams"}` +
                (sg.coveragePct != null ? ` · ~${sg.coveragePct}% covered` : "") +
                (sg.note ? ` — ${sg.note}` : "")
              : "not available"
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
              : "not available"
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
              : "not available"
          }
        />
        <MetricCard
          icon="🌊"
          label="Rip current risk"
          value={!rip || rip === "unknown" ? "—" : cap(rip)}
          sub={rip && rip !== "unknown" ? "NWS Surf Zone Forecast" : "not available"}
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
        <LocalCoverage location={snap.location} hasCams={cams.length > 0} />
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
        {/* Visible affordance for desktop, where pull-to-refresh isn't available. */}
        <div className="flex justify-center">
          <button
            type="button"
            onClick={() => onRefresh()}
            disabled={isValidating}
            className="inline-flex min-h-[36px] items-center gap-1.5 rounded-full bg-white/80 dark:bg-slate-900/70 px-3 py-1 text-xs text-slate-600 dark:text-slate-400 ring-1 ring-slate-900/10 dark:ring-white/10 transition hover:ring-amber-400/40 disabled:opacity-60"
            aria-label="Refresh conditions"
          >
            <span aria-hidden className={isValidating ? "animate-spin" : undefined}>
              ↻
            </span>
            {isValidating ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </footer>
    </main>
    </PullToRefresh>
  );
}
