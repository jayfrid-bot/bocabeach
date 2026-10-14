"use client";

import { useState } from "react";
import type {
  CityOfficialData,
  LightningData,
  NwsData,
  RipNwpsBeachSeries,
  WaterQualityData,
  Wrapped,
} from "@/lib/types";
import { fmtDate } from "@/lib/format";
import { buildSafetyBanner } from "@/lib/safetyBanner";
import { degToCardinal } from "@/lib/util";
import { LifeguardFlag } from "@/components/LifeguardFlag";

export function SafetyBanner({
  city,
  water,
  lightning,
  nws,
  ripNwps,
  timezone = "America/New_York",
  nowMs,
}: {
  city: Wrapped<CityOfficialData>;
  water?: Wrapped<WaterQualityData>;
  lightning?: Wrapped<LightningData>;
  nws?: Wrapped<NwsData>;
  /** NOAA's official hourly rip current model, when this beach has mapped
   *  coverage — lets the rip block resolve against the model, not just the
   *  SRF word (see lib/ripRisk/resolve.ts's priority order). */
  ripNwps?: Wrapped<RipNwpsBeachSeries>;
  /** Beach IANA timezone, so alert end-times read in local time nationwide. */
  timezone?: string;
  /** The clock to resolve rip alert/forecast status against — callers pass
   *  the same pinned-then-live `nowMs` the rest of the dashboard uses (never
   *  `Date.now()` inline here), so server render and client hydration agree. */
  nowMs: number;
}) {
  const [expanded, setExpanded] = useState(false);
  // Everything the banner decides lives in lib/safetyBanner.ts, shared with the
  // Apple Watch view so the two cannot drift.
  const model = buildSafetyBanner({ city, water, lightning, nws, ripNwps, timezone, nowMs });
  const data = city.data;
  const wq = water?.data;
  const {
    tone,
    flags,
    advisory,
    lightningDanger,
    noSwim,
    ripNow,
    ripBannerCopy,
    hasRipToShow,
    beachHazards,
    otherAlerts,
    upcomingNonRipAlerts,
    headline,
    otherLabel,
  } = model;
  const lt = model.lightningData;
  if (model.hidden) return null;

  // Theme-aware rip-risk text colors. The 400-level low/moderate tints are
  // invisible on the light amber card, so use darker shades in light mode.
  const RIP_TEXT = {
    high: "text-rose-700 dark:text-rose-300",
    moderate: "text-amber-700 dark:text-amber-300",
    low: "text-emerald-700 dark:text-emerald-300",
  } as const;

  // Sites driving the advisory + the most recent sample date among them.
  const badSites = (wq?.sites ?? []).filter((s) => s.rating === "poor");
  const sampledAt = badSites
    .map((s) => s.sampledAt)
    .filter(Boolean)
    .sort()
    .pop();

  const flagsNode = data ? (
    flags.length === 0 ? (
      <span className="text-slate-500 dark:text-slate-400">No flags reported</span>
    ) : (
      <span className="flex min-w-0 items-center gap-2 overflow-hidden">
        {flags.map((f) => (
          <LifeguardFlag key={f} flag={f} inline compact swatchOnly={!!otherLabel} />
        ))}
      </span>
    )
  ) : null;
  const headlineTextTone =
    tone === "danger"
      ? "text-rose-800 dark:text-rose-200"
      : tone === "caution"
        ? "text-amber-800 dark:text-amber-200"
        : "text-slate-800 dark:text-slate-100";

  return (
    <div
      className={`overflow-hidden rounded-2xl ring-1 ${
        tone === "danger"
          ? "bg-rose-500/10 ring-rose-500/40"
          : tone === "caution"
            ? "bg-amber-500/10 ring-amber-500/30"
            : "bg-white/80 dark:bg-slate-900/70 ring-slate-900/10 dark:ring-white/10"
      }`}
    >
      {/* Compact header: headline warning + one line for the rest + flags —
          always visible, tap to reveal the full detail (incl. NOAA/NWS
          attribution) below. */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="flex w-full min-w-0 items-start gap-2.5 p-3 text-left sm:p-4"
      >
        <span aria-hidden className="mt-0.5 shrink-0 text-base leading-none">
          {headline?.icon ?? "🚩"}
        </span>
        <span className="min-w-0 flex-1">
          {headline ? (
            <span className={`block truncate text-sm font-semibold ${headlineTextTone}`}>
              {headline.text}
            </span>
          ) : null}
          <span className="mt-0.5 flex min-w-0 flex-nowrap items-center gap-x-2 overflow-hidden text-xs text-slate-600 dark:text-slate-300 sm:text-sm">
            {/* Names the next most severe item — truncates (not shrink-0)
                so the flags after it stay fully visible when space is
                tight; that's what "when it fits" means here. */}
            {otherLabel ? <span className="min-w-0 truncate font-medium">{otherLabel}</span> : null}
            {otherLabel && flagsNode ? (
              <span aria-hidden className="shrink-0 text-slate-400">
                ·
              </span>
            ) : null}
            {flagsNode}
          </span>
        </span>
        <span
          aria-hidden
          className={`mt-1 shrink-0 text-xs text-slate-400 transition-transform ${expanded ? "rotate-180" : ""}`}
        >
          ▾
        </span>
      </button>

      {expanded ? (
        <div className="space-y-3 px-3 pb-3 sm:px-4 sm:pb-4">
          {advisory ? (
            <div className="rounded-xl bg-rose-500/15 p-3 ring-1 ring-rose-500/40">
              <div className="flex items-center gap-2 text-sm font-semibold text-rose-800 dark:text-rose-200">
                <span aria-hidden>🧫</span>
                <span>Water quality advisory — swimming not recommended</span>
              </div>
              <div className="mt-1 text-xs text-rose-700/90 dark:text-rose-100/80">
                High enterococci bacteria
                {badSites.length ? ` at ${badSites.map((s) => s.name).join(", ")}` : ""}.
                {sampledAt ? ` Sampled ${fmtDate(sampledAt, "UTC")}.` : ""}{" "}
                {water?.attribution ?? "Florida Healthy Beaches"}.
              </div>
            </div>
          ) : null}

          {noSwim ? (
            <div className="rounded-xl bg-rose-500/15 p-3 ring-1 ring-rose-500/40">
              <div className="flex items-center gap-2 text-sm font-semibold text-rose-800 dark:text-rose-200">
                <span aria-hidden>🚫</span>
                <span>{noSwim.title}</span>
              </div>
              <div className="mt-1 text-xs text-rose-700/90 dark:text-rose-100/80">
                Active City of Boca Raton advisory.{" "}
                <a
                  href={noSwim.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline"
                >
                  Read the alert
                </a>
              </div>
            </div>
          ) : null}

          {lightningDanger ? (
            <div className="rounded-xl bg-rose-500/15 p-3 ring-1 ring-rose-500/40">
              <div className="flex items-center gap-2 text-sm font-semibold text-rose-800 dark:text-rose-200">
                <span aria-hidden>⛈️</span>
                <span>Lightning nearby — get out of the water and seek shelter</span>
              </div>
              <div className="mt-1 text-xs text-rose-700/90 dark:text-rose-100/80">
                Nearest strike {lt?.nearestMi} mi
                {lt?.nearestBearingDeg != null ? ` to the ${degToCardinal(lt.nearestBearingDeg)}` : ""}
                {lt?.nearestMinutesAgo != null ? ` · ${lt.nearestMinutesAgo} min ago` : ""}. NOAA GOES
                GLM.
              </div>
            </div>
          ) : null}

          {beachHazards.length ? (
            <div className="rounded-xl bg-amber-500/15 p-3 ring-1 ring-amber-500/40">
              <div className="flex items-center gap-2 text-sm font-semibold text-amber-800 dark:text-amber-200">
                <span aria-hidden>🚩</span>
                <span>
                  NWS Beach Hazards {beachHazards.length > 1 ? "Statements" : "Statement"} in effect
                </span>
              </div>
              <ul className="mt-1 space-y-0.5 text-xs text-amber-800/90 dark:text-amber-100/80">
                {beachHazards.map((a) => (
                  <li key={a.event + (a.ends ?? "")}>
                    {a.headline ?? a.event}
                    {a.ends ? ` — until ${fmtDate(a.ends, timezone)}` : ""}
                  </li>
                ))}
              </ul>
              <div className="mt-1 text-[11px] text-amber-700/80 dark:text-amber-200/70">
                The National Weather Service has flagged hazardous conditions for swimmers here —
                heed it where local lifeguard flags aren&apos;t posted. NOAA/NWS.
              </div>
            </div>
          ) : null}

          {upcomingNonRipAlerts.length ? (
            // A product that HASN'T started yet — its own explicit block (item
            // 1), never folded into the "in effect" lists above.
            <div className="rounded-xl bg-slate-500/10 p-3 ring-1 ring-slate-500/30">
              <ul className="space-y-0.5 text-xs font-medium text-slate-700 dark:text-slate-300">
                {upcomingNonRipAlerts.map((a) => (
                  <li key={a.event + (a.onset ?? "")}>
                    <span aria-hidden>🕐</span> {a.event}
                    {a.onset ? ` begins ${fmtDate(a.onset, timezone)}` : ""}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {hasRipToShow || otherAlerts.length ? (
            <div
              className={`rounded-xl p-3 ring-1 ${
                ripNow.source === "alert" && ripNow.level === "high"
                  ? "bg-rose-500/15 ring-rose-500/40"
                  : "bg-amber-500/10 ring-amber-500/30"
              }`}
            >
              {hasRipToShow ? (
                // One plain, non-contradicting line for whatever ripNow resolved
                // to — warning/model/forecast, plus an upcoming-warning suffix
                // when there is one (lib/ripRisk/copy.ts's ripCopy).
                <div
                  className={`flex items-center gap-2 text-sm font-semibold ${RIP_TEXT[ripNow.level === "unknown" ? "high" : ripNow.level]}`}
                >
                  <span aria-hidden>🌊</span>
                  <span>{ripBannerCopy.bannerText}</span>
                </div>
              ) : null}
              {otherAlerts.length ? (
                <ul className="mt-1 space-y-0.5 text-xs text-slate-700 dark:text-slate-300">
                  {otherAlerts.map((a) => (
                    <li key={a.event + (a.ends ?? "")}>
                      ⚠ {a.event}
                      {a.ends ? ` — until ${fmtDate(a.ends, timezone)}` : ""}
                    </li>
                  ))}
                </ul>
              ) : null}
              <div className="mt-1 text-[11px] text-slate-500">NOAA/NWS</div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
