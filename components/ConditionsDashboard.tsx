"use client";

import Link from "next/link";
import { useCallback } from "react";
import useSWR from "swr";
import type { ConditionsResponse } from "@/lib/types";
import { consensusCloudPct, currentHourOf, deriveMetrics } from "@/lib/score";
import { computeStormActivity } from "@/lib/stormActivity";
import { beachDayVerdict, fmtDate, fmtTime, scoreTextClass } from "@/lib/format";
import { Logo } from "@/components/Logo";
import { ThemeToggle } from "@/components/ThemeToggle";
import { ScoreExplainer } from "@/components/ScoreExplainer";
import { PullToRefresh } from "@/components/PullToRefresh";
import { ScoreWheel } from "@/components/ScoreWheel";
import { AirQualityMeter } from "@/components/AirQualityMeter";
import { StormActivityMeter } from "@/components/StormActivityMeter";
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
import { UvCard } from "@/components/UvCard";
import { BusynessCard } from "@/components/BusynessCard";
import { WindCompass } from "@/components/WindCompass";
import { WaveHeightCard } from "@/components/WaveHeightCard";
import { FlipCard, NerdBack } from "@/components/FlipCard";
import { buildNerdInfo, type NerdContext } from "@/lib/nerdInfo";
import { TidePanel } from "@/components/TidePanel";
import { SunPanel } from "@/components/SunPanel";
import { SafetyBanner } from "@/components/SafetyBanner";
import { SandTempPanel } from "@/components/SandTempPanel";
import { SourceList } from "@/components/SourceBadge";
import { CamGrid } from "@/components/CamGrid";
import { DayOutlookStrip } from "@/components/DayOutlookStrip";
import { NotifyButton } from "@/components/NotifyButton";
import { ChangelogSection } from "@/components/ChangelogSection";
import { FeelsLikeCard } from "@/components/FeelsLikeCard";
import { SunQualityCard } from "@/components/SunQualityCard";
import { WaterTrendCard } from "@/components/WaterTrendCard";
import { RipRiskCard } from "@/components/RipRiskCard";
import { MarineStingerCard } from "@/components/MarineStingerCard";
import { SharkContextCard } from "@/components/SharkContextCard";
import { seaweedVsAvgPhrase } from "@/lib/vsAveragePhrase";
import { clarityDisplayWord } from "@/lib/sources/clarity";

// Throw on non-OK so an error body (e.g. a 404 `{error}`) never replaces the
// good snapshot — SWR keeps the last good data and the consumer guard holds.
const fetcher = (u: string) =>
  fetch(u).then((r) => {
    if (!r.ok) throw new Error(String(r.status));
    return r.json();
  });

// Stamped into the bundle at build time (see next.config.mjs) for the footer.
// BUILD_NUM is the git commit count (auto-increments every commit) and GIT_SHA
// pins the exact commit, so "which build is this phone actually running?" is
// answerable at a glance — pkg.version alone never changed.
const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? "dev";
const BUILD_NUM = process.env.NEXT_PUBLIC_BUILD_NUM;
const GIT_SHA = process.env.NEXT_PUBLIC_GIT_SHA;
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
  isNativeApp = false,
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
  /** Server-detected native shell (request UA) — drives the Notify button. */
  isNativeApp?: boolean;
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
  const clarity = snap.clarity.data;
  const traffic = snap.traffic.data;
  const rip = snap.nws.data?.ripCurrentRisk;
  const nc = snap.nowcast.data;

  // Shared context for the flip-card "data nerd" backs (the math + sources
  // behind each card). Built once from the same derived metrics + snapshot the
  // fronts render, so a back always matches its front. See lib/nerdInfo.ts.
  const nerd: NerdContext = { d, snap };
  const nerdBack = (key: Parameters<typeof buildNerdInfo>[0]) => (
    <NerdBack info={buildNerdInfo(key, nerd)} />
  );
  // Busyness front hides itself (returns null) at night / with no note — mirror
  // that here so we never render a blank flippable card.
  const showBusyness = !!busy && !(busy.level === "unknown" && !busy.note);

  // "Best window today" pill — reuse the server-computed Today window from
  // multiDayWindows[0] so the pill and the Best-times strip always show the SAME
  // window (a client recompute used different daylight bounds + a different clock).
  const bw = res.multiDayWindows?.[0]?.best ?? null;
  // "Now" cloud is the multi-source consensus (the Sky card's number) — a single
  // model's hourly cloud flip-flops and mis-drives the overcast damping.
  const nowCloudPct = consensusCloudPct(snap);
  // Storm activity: strike density + proximity (from the lightning feed) blended
  // with the current hour's rain — see lib/stormActivity.ts for the scoring.
  const currentHour = currentHourOf(snap.hourly.data ?? []);
  const storm = computeStormActivity({
    lightning: snap.lightning,
    precipIn: currentHour?.precipIn,
    weatherCode: currentHour?.weatherCode,
    precipProbability: currentHour?.precipProbability,
  });

  // --- Informational advisories (computed server-side in lib/conditions.ts;
  // NONE feed the Beach Day score). Each self-hides when it has nothing to say. ---
  const wt = snap.waterTrend ?? null;
  const ms = snap.marineStinger ?? null;
  const shark = snap.sharkContext ?? null;
  // Feels-like needs air + humidity (its two irreplaceable inputs) — hide the
  // whole card when they're absent, matching how busyness/seaweed hide.
  const showFeelsLike = d.airTempF != null && d.humidityPct != null;
  // Mirror MarineStingerCard's own show logic so the advisory section only takes
  // up room when a card will actually render (both cards self-hide otherwise).
  const showMarineStinger =
    !!ms &&
    ((!!ms.manOWar && ms.manOWar.level !== "low") ||
      (!!ms.seaLice && ms.seaLice.level !== "low"));
  const showSharkContext = !!shark;
  // Map the hourly forecast into the sky-show card's cloud/humidity points; the
  // cloud-by-level fields (added to the hourly fetch) sharpen the color-canvas
  // model, degrading to total cloud where a level split isn't available.
  const sunQualityHourly = (snap.hourly.data ?? []).map((h) => ({
    time: h.time,
    cloud: {
      lowPct: h.cloudCoverLowPct,
      midPct: h.cloudCoverMidPct,
      highPct: h.cloudCoverHighPct,
      totalPct: h.cloudCoverPct,
    },
    humidityPct: h.humidityPct,
  }));

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
    snap.goesCloud,
    snap.sargassum,
    snap.busyness,
    snap.traffic,
    snap.forecast,
    snap.sun,
    snap.hourly,
  ].filter((s) => s.data != null); // list only sources that actually delivered data for this beach

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
          {!preview ? <NotifyButton slug={slug} serverNative={isNativeApp} /> : null}
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

      {/* The score is the headline answer, so it leads the page (right under any
          safety banner). Verdict word, the interactive factor wheel with the
          number in its center. */}
      <section className="mb-6">
        {active.dataAvailable === false ? (
          // Total data outage: every sub-score was unavailable, so a confident
          // 0 / "Not really" would be misleading. Say so plainly instead.
          <div className="mx-auto flex w-full max-w-md flex-col items-center gap-2 rounded-2xl bg-white/80 dark:bg-slate-900/70 p-6 text-center ring-1 ring-slate-900/10 dark:ring-white/10">
            <span aria-hidden className="text-3xl">
              📡
            </span>
            <div className="text-xl font-bold text-slate-900 dark:text-white">
              Conditions unavailable
            </div>
            <div className="text-sm text-slate-600 dark:text-slate-400">
              We could not reach the data sources right now. Try refreshing in a
              few minutes.
            </div>
          </div>
        ) : (
          <>
            <div
              className={`mb-2 text-center text-3xl font-bold ${scoreTextClass(active.score)}`}
            >
              {beachDayVerdict(active.score)}
            </div>
            <ScoreWheel result={active} />
            {/* (Lifeguard swim/snorkel/surf ratings live in the LifeguardReport
                card below — a duplicate line here was removed.) */}
          </>
        )}
      </section>

      <section className="mb-6">
        <ScoreExplainer derived={d} result={active} />
      </section>

      {nc || bw ? (
        <section className="mb-4 flex flex-wrap gap-2 text-sm">
          {/* Suppress a "Raining" pill the corroboration gate vetoed (see
              deriveMetrics.nowcastRaining) — the minutely model hallucinates
              showers under clear skies; showing "Raining" in bright sun burns
              trust. The dry state and corroborated rain render as before. */}
          {nc && (nc.state !== "raining" || d.nowcastRaining) ? (
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

      {res.multiDayWindows?.length || snap.forecast.data?.length ? (
        <section className="mb-6">
          <DayOutlookStrip days={res.multiDayWindows ?? []} forecast={snap.forecast} tz={tz} />
        </section>
      ) : null}

      <h2 className="mb-3 mt-2 text-lg font-semibold text-slate-900 dark:text-white">
        Explore the details
      </h2>

      {/* Instruments: the four graphic cards in one band so every row pairs
          equal-height cards (default grid stretch + h-full on each card). Each
          is a FlipCard — tap to reveal the math/sources on the back. */}
      <section className="mb-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <FlipCard
          label="Wind"
          back={nerdBack("wind")}
          front={
            <div className="flex h-full flex-col rounded-2xl bg-white/80 dark:bg-slate-900/70 p-4 ring-1 ring-slate-900/10 dark:ring-white/10">
              <div className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400">
                <span aria-hidden>💨</span>
                <span>Wind</span>
              </div>
              <div className="mt-2 flex flex-1 items-center justify-center">
                <WindCompass fromDeg={d.windDirDeg} speedMph={d.windSpeedMph} />
              </div>
            </div>
          }
        />
        {d.waveHeightFt != null ? (
          <FlipCard
            label="Waves"
            back={nerdBack("waves")}
            front={<WaveHeightCard waveHeightFt={d.waveHeightFt} />}
          />
        ) : null}
        <FlipCard
          label="UV index"
          back={nerdBack("uv")}
          front={
            d.uvIndex != null ? (
              <UvCard uvIndex={d.uvIndex} />
            ) : (
              <MetricCard icon="🔆" label="UV index" value="—" sub="not available" />
            )
          }
        />
        {/* Feels-like beach temp — heat index + sun + hot-sand − wind. Self-wraps
            its own FlipCard/NerdBack. Hidden when air temp / humidity are absent. */}
        {showFeelsLike ? (
          <FeelsLikeCard
            airTempF={d.airTempF}
            humidityPct={d.humidityPct}
            windSpeedMph={d.windSpeedMph}
            cloudCoverPct={nowCloudPct}
            sandTempF={d.sandTempF}
            // Real day/night + sun-strength signals so the solar term is never
            // fabricated from missing inputs: the explicit daytime flag AND the
            // current hour's modeled irradiance (0 overnight). Without these the
            // solar load is omitted rather than assumed full-strength.
            isDaytime={snap.weather.data?.isDaytime}
            solarWm2={currentHour?.solarWm2}
          />
        ) : null}
        {/* Sunrise/sunset "sky show" score — a sun-related scored instrument, so
            it sits with UV here. `now` is pinned to the snapshot's generatedAt so
            the next-event pick is identical on the server render and hydration. */}
        {snap.sun.data && snap.hourly.data?.length ? (
          <SunQualityCard
            now={new Date(snap.generatedAt)}
            tz={tz}
            today={{
              sunrise: snap.sun.data.sunrise,
              sunset: snap.sun.data.sunset,
              goldenAm: {
                goldenStartIso: snap.sun.data.goldenAmStartIso,
                goldenEndIso: snap.sun.data.goldenAmEndIso,
                peakAnchorIso: snap.sun.data.goldenAmPeakIso,
              },
              goldenEve: {
                goldenStartIso: snap.sun.data.goldenEveStartIso,
                goldenEndIso: snap.sun.data.goldenEveEndIso,
                peakAnchorIso: snap.sun.data.goldenEvePeakIso,
              },
            }}
            tomorrow={{
              sunriseIso: snap.sun.data.tomorrowSunrise,
              goldenAm: {
                goldenStartIso: snap.sun.data.tomorrowGoldenAmStartIso,
                goldenEndIso: snap.sun.data.tomorrowGoldenAmEndIso,
                peakAnchorIso: snap.sun.data.tomorrowGoldenAmPeakIso,
              },
            }}
            hourly={sunQualityHourly}
            airQuality={snap.airQuality.data}
            goesCloud={
              snap.goesCloud.data
                ? { ...snap.goesCloud.data, status: snap.goesCloud.status }
                : null
            }
          />
        ) : null}
        {showBusyness ? (
          <FlipCard label="Busyness" back={nerdBack("busyness")} front={<BusynessCard busy={busy} />} />
        ) : null}
      </section>

      {/* Readings: compact text tiles only — same shape per row (default grid
          stretch equalizes rows). Each tile is a FlipCard; the height floor
          keeps the (taller) nerd back readable, and the band stays uniform. */}
      <section className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        <FlipCard
          label="Air temp"
          back={nerdBack("airTemp")}
          front={
            <MetricCard
              icon="☀️"
              label="Air temp"
              value={d.airTempF != null ? `${d.airTempF}°F` : "—"}
              sub={d.airTempF != null ? d.shortForecast : "not available"}
            />
          }
        />
        <FlipCard
          label="Water temp"
          back={nerdBack("waterTemp")}
          front={
            // Inline MetricCard markup so the water-"feel"-trend pill can sit in
            // the reserved sub-line area. The pill self-hides on a "steady" (or
            // absent) trend, so a normal day looks exactly like the plain tile.
            <div className="flex h-full flex-col rounded-2xl bg-white/80 dark:bg-slate-900/70 p-4 ring-1 ring-slate-900/10 dark:ring-white/10">
              <div className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400">
                <span aria-hidden>🌡️</span>
                <span className="truncate">Water temp</span>
              </div>
              <div className="flex flex-1 flex-col justify-center">
                <div className="text-xl font-semibold text-slate-900 dark:text-white sm:text-2xl">
                  {d.waterTempF != null ? `${d.waterTempF}°F` : "—"}
                </div>
                <div className="min-h-4 break-words text-xs text-slate-600 dark:text-slate-400 line-clamp-3">
                  {d.waterTempF == null ? "not available" : " "}
                </div>
                {wt && wt.status !== "steady" ? (
                  <div className="mt-1.5">
                    <WaterTrendCard trend={wt} />
                  </div>
                ) : null}
              </div>
            </div>
          }
        />
        <FlipCard
          label="Humidity"
          back={nerdBack("humidity")}
          front={
            <MetricCard
              icon="💧"
              label="Humidity"
              value={d.humidityPct != null ? `${d.humidityPct}%` : "—"}
              sub={d.humidityPct != null ? humidityNote(d.humidityPct) : "not available"}
            />
          }
        />
        <FlipCard
          label="Dew point"
          back={nerdBack("dewPoint")}
          front={
            <MetricCard
              icon="🌫️"
              label="Dew point"
              value={d.dewPointF != null ? `${d.dewPointF}°F` : "—"}
              sub={d.dewPointF != null ? dewComfort(d.dewPointF) : "not available"}
            />
          }
        />
        <FlipCard
          label="Cloud cover"
          back={nerdBack("cloudCover")}
          front={
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
          }
        />
        {d.precipProbability != null ? (
          <FlipCard
            label="Rain chance"
            back={nerdBack("rainChance")}
            front={<MetricCard icon="🌧️" label="Rain chance" value={`${d.precipProbability}%`} />}
          />
        ) : null}
        <FlipCard
          label="Water quality"
          back={nerdBack("waterQuality")}
          front={
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
          }
        />
        {clarity ? (
          <FlipCard
            label="Water clarity"
            back={nerdBack("clarity")}
            front={
              <MetricCard
                icon="🔍"
                label="Water clarity"
                value={clarity.level ? clarityDisplayWord(clarity.level, clarity.pct) : "—"}
                sub={
                  clarity.level
                    ? [
                        clarity.pct != null ? `~${clarity.pct}% clear` : null,
                        clarity.note,
                        clarity.capturedAtLocal
                          ? `as of ${fmtTime(clarity.capturedAtLocal, tz)}`
                          : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")
                    : clarity.note ?? "not available"
                }
              />
            }
          />
        ) : null}
        <FlipCard
          label="Rip current risk"
          back={nerdBack("ripCurrent")}
          front={
            <MetricCard
              icon="🌊"
              label="Rip current risk"
              value={!rip || rip === "unknown" ? "—" : cap(rip)}
              sub={rip && rip !== "unknown" ? "NWS Surf Zone Forecast" : "not available"}
            />
          }
        />
        {sg && sg.level !== "unknown" ? (
          <FlipCard
            label="Seaweed"
            back={nerdBack("seaweed")}
            front={
              <MetricCard
                icon="🪸"
                label="Seaweed (sargassum)"
                value={cap(sg.level)}
                sub={
                  `📷 ${sg.isMorning ? "AM cams (pre-clean)" : "cams"}` +
                  (sg.coveragePct != null ? ` · ~${sg.coveragePct}% covered` : "") +
                  // vs-average FIRST (before the cam note) so the 3-line clamp
                  // never eats it.
                  seaweedVsAvgPhrase(sg.vsAvg) +
                  (sg.note ? ` — ${sg.note}` : "")
                }
              />
            }
          />
        ) : null}
        {traffic && traffic.level !== "unknown" ? (
          <FlipCard
            label="Traffic"
            back={nerdBack("traffic")}
            front={
              <MetricCard
                icon="🚗"
                label="Traffic"
                value={cap(traffic.level)}
                sub={
                  traffic.congestion != null
                    ? `${traffic.congestion}% congestion near the beach`
                    : "near the beach"
                }
              />
            }
          />
        ) : null}
      </section>

      {snap.hourly.data?.length ? (
        <section className="mb-6">
          {/* Full-width flagship instrument: the front (SandTempPanel) sits in
              normal flow and pins the height; the nerd back overlays it and
              scrolls internally for the long story. */}
          <FlipCard
            label="Sand temperature"
            back={nerdBack("sandTemp")}
            front={
              <SandTempPanel
                hours={snap.hourly.data}
                sunriseIso={snap.sun.data?.sunrise}
                sunsetIso={snap.sun.data?.sunset}
                tz={tz}
                lon={snap.location.lon}
                nowCloudCoverPct={nowCloudPct}
              />
            }
          />
        </section>
      ) : null}

      <section className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <FlipCard
          label="Air quality"
          back={nerdBack("airQuality")}
          front={
            <div className="h-full [&>div]:h-full">
              <AirQualityMeter air={snap.airQuality} />
            </div>
          }
        />
        {/* Storm + Lightning are flippable showpieces. The h-full wrapper +
            child-stretch keeps the front card filling its grid cell (these two
            components don't set their own height) so a flipped card matches the
            row height of its neighbours. StormActivityMeter renders nothing when
            the metric is null, so mirror that and skip the FlipCard entirely. */}
        {storm ? (
          <FlipCard
            label="Storm activity"
            back={nerdBack("storm")}
            front={
              <div className="h-full [&>div]:h-full">
                <StormActivityMeter storm={storm} />
              </div>
            }
          />
        ) : null}
        <FlipCard
          label="Lightning"
          back={nerdBack("lightning")}
          front={
            <div className="h-full [&>div]:h-full">
              <LightningCard lightning={snap.lightning} />
            </div>
          }
        />
        {/* Hourly rip-current risk curve — anchored on (and never contradicting)
            the official NWS word, sitting in the safety cluster. Self-wraps its
            FlipCard and renders nothing when there's no official word to anchor. */}
        {snap.ripRisk ? <RipRiskCard curve={snap.ripRisk} tz={tz} /> : null}
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
        <FlipCard
          label="Tides"
          back={nerdBack("tides")}
          front={
            <div className="h-full [&>div]:h-full">
              <TidePanel tides={snap.tides} tz={tz} />
            </div>
          }
        />
        <FlipCard
          label="Sun & moon"
          back={nerdBack("sun")}
          front={
            <div className="h-full [&>div]:h-full">
              <SunPanel sun={snap.sun} tz={tz} />
            </div>
          }
        />
      </section>

      {/* Quiet, exception-only advisories (SE-US-Atlantic beaches only) — kept
          low on the page like the tide-aberration badges. Both cards self-hide,
          and the section only mounts when at least one has something to say. */}
      {showMarineStinger || showSharkContext ? (
        <section className="mb-6 grid gap-4 sm:grid-cols-2">
          {showMarineStinger ? (
            <MarineStingerCard manOWar={ms!.manOWar} seaLice={ms!.seaLice} />
          ) : null}
          {showSharkContext ? <SharkContextCard context={shark} /> : null}
        </section>
      ) : null}

      {cams.length > 0 ? (
        <section className="mb-8">
          <CamGrid cams={cams} tz={tz} />
        </section>
      ) : null}

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
          {BUILD_NUM && BUILD_NUM !== "0" ? ` · build ${BUILD_NUM}` : ""}
          {GIT_SHA && GIT_SHA !== "dev" ? ` (${GIT_SHA})` : ""}
          {BUILD_TIME && (
            <>
              <span className="mx-1.5 text-slate-400 dark:text-slate-600">·</span>
              last built {fmtDate(BUILD_TIME, tz)}, {fmtTime(BUILD_TIME, tz)}
            </>
          )}
          <span className="mx-1.5 text-slate-400 dark:text-slate-600">·</span>
          data updated {fmtDate(snap.generatedAt, tz)}, {fmtTime(snap.generatedAt, tz)}
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
        <ChangelogSection />
      </footer>
    </main>
    </PullToRefresh>
  );
}
