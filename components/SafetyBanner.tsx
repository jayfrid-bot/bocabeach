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
import { safetyTone } from "@/lib/safetyTone";
import { resolveRipNow } from "@/lib/ripRisk";
import { isAlertInEffectAt, isAlertUpcomingAt } from "@/lib/ripRisk/resolve";
import { isRipAlertEvent } from "@/lib/ripRisk/types";
import { ripCopy } from "@/lib/ripRisk/copy";
import { modelNowFromSeries } from "@/lib/sources/ripNwps";
import { degToCardinal } from "@/lib/util";
import { LifeguardFlag } from "@/components/LifeguardFlag";
import { isWarningTierAlert, rankSafetyItems, type SafetyItem } from "@/lib/safetyBannerRank";

// Plain labels for the compact headline only — the flags ROW (always shown,
// see below) still renders the real swatches via LifeguardFlag; this is just
// what a flag reads as when IT is the worst (or only) thing the banner has
// to say.
const FLAG_HEADLINE: Record<string, string> = {
  "double-red": "Double red flag — water access closed",
  red: "Red flag — high hazard",
  purple: "Purple flag — dangerous marine life",
  yellow: "Yellow flag — medium hazard",
  green: "Green flag — low hazard",
};

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
  const data = city.data;
  const wq = water?.data;
  const advisory = wq?.advisory ?? false;
  const lt = lightning?.data;
  // A strike within 5 mi during the scanned window → get out of the water.
  // Gate on a fresh "ok" snapshot so a stale feed never shows the red block.
  const lightningDanger =
    (lt?.nearestMi ?? Infinity) <= 5 &&
    lightning?.status === "ok" &&
    (lt?.lastMinutesAgo == null || lt.lastMinutesAgo <= 30);
  const noSwim = data?.noSwimAdvisory;
  const alerts = nws?.data?.alerts ?? [];
  // Temporally-resolved rip status (2026-09-24 fix): an alert actually in
  // effect (always High) > a fresh NOAA rip current model reading (possibly
  // softened vs. a disagreeing SRF word, or upgrade-only once aging) > the
  // current SRF period's word > unknown. Drives both the tone and the rip
  // block's wording below — never the flat SRF word, and never a merely
  // SCHEDULED alert.
  const ripNow = resolveRipNow({
    alerts,
    srfPeriods: nws?.data?.srfPeriods,
    model: modelNowFromSeries(ripNwps?.data ?? null, nowMs),
    now: nowMs,
  });
  // A NWS Beach Hazards Statement is the national "is it safe to swim" signal —
  // the honest substitute where local lifeguard flags aren't tracked. Pull it
  // out of the generic alert list; rip-current statements (and a rip-
  // mentioning BHS — isRipAlertEvent) get their OWN block below (with in-
  // effect/scheduled/forecast-only distinction), never this one. Both
  // partitions AND the tone's alertEvents now use the SAME shared
  // isAlertInEffectAt (item 1) — a scheduled-but-not-started or already-
  // ended product must never read as active here, matching score.ts's
  // severeAlert/surfAdvisory and evaluate.ts's push path. Scheduled (not yet
  // in effect) non-rip products get their OWN explicit "upcoming" block
  // instead of silently vanishing.
  const nonRipAlerts = alerts.filter((a) => !isRipAlertEvent(a));
  const activeNonRipAlerts = nonRipAlerts.filter((a) => isAlertInEffectAt(a, nowMs));
  const upcomingNonRipAlerts = nonRipAlerts.filter((a) => isAlertUpcomingAt(a, nowMs));
  const beachHazards = activeNonRipAlerts.filter((a) => /beach hazard/i.test(a.event));
  const otherAlerts = activeNonRipAlerts.filter((a) => !/beach hazard/i.test(a.event));
  const flags = data?.flags.filter((f) => f !== "unknown") ?? [];
  // The container's tone must match the WORST thing inside it — see safetyTone's
  // doc for the alarm-over-all-clear bug this replaced. Pure + unit-tested there.
  const tone = safetyTone({
    advisory,
    lightningDanger,
    noSwim: !!noSwim,
    ripNow,
    flags,
    alertEvents: activeNonRipAlerts.map((a) => a.event),
  });

  // Plain, non-contradicting rip copy (lib/ripRisk/copy.ts) — one line for
  // the banner, built from the same resolved ripNow the tone/cap use.
  const ripBannerCopy = ripCopy(ripNow, ripNwps?.data?.hours ?? null, nowMs, timezone);

  // Nothing worth surfacing in the safety header. Marine life and posted
  // hazards now live in their own LifeguardReport card lower on the page —
  // they don't gate this banner. A resolved "low" from the model/forecast
  // with nothing upcoming is NOT worth a block — a near-empty amber card
  // saying nothing but "Low" is noise, not signal (only an in-effect alert,
  // or a moderate/high reading, or a scheduled future alert, earns a block).
  const hasRipToShow =
    ripNow.source === "alert" ||
    ((ripNow.source === "model" || ripNow.source === "forecast") && ripNow.level !== "low") ||
    ripNow.upcomingAlert != null;
  if (
    !advisory &&
    !lightningDanger &&
    !noSwim &&
    !hasRipToShow &&
    // The RESOLVED collections (item 4) — not raw `alerts.length`, which
    // would keep the banner up for an alert that's neither active nor
    // upcoming (already ended, or a rip alert handled entirely elsewhere)
    // and render nothing at all.
    activeNonRipAlerts.length === 0 &&
    upcomingNonRipAlerts.length === 0 &&
    flags.length === 0
  ) {
    return null;
  }

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

  // --- Compact summary (item 2 of the redesign) --------------------------
  // One candidate per hazard SOURCE (never batched — a Tornado Warning and a
  // Coastal Flood Advisory must be able to sort apart even though the old
  // code lumped every non-beach-hazard alert into one "otherAlerts" bucket),
  // ranked worst-first by lib/safetyBannerRank.ts (unit-tested there). This
  // list drives ONLY the collapsed headline + summary line — the full blocks
  // below still render off the same booleans they always have.
  const candidates: SafetyItem[] = [];
  if (lightningDanger) {
    candidates.push({
      kind: "lightning",
      icon: "⛈️",
      text: "Lightning nearby — get out of the water and seek shelter",
      id: "lightning",
    });
  }
  for (const a of activeNonRipAlerts) {
    candidates.push({
      kind: isWarningTierAlert(a) ? "warningAlert" : "softAdvisory",
      icon: /beach hazard/i.test(a.event) ? "🚩" : "⚠️",
      // The plain product name ("Coastal Flood Advisory"), not `a.headline`
      // — NWS headlines are full CAP sentences ("...issued September 27 at
      // 4:15 PM EDT until...") that read fine in the expanded detail below
      // but only clutter a one-line compact summary.
      text: a.event,
      id: `alert:${a.event}:${a.ends ?? ""}`,
    });
  }
  if (advisory) {
    candidates.push({
      kind: "closure",
      icon: "🧫",
      text: "Water quality advisory — swimming not recommended",
      id: "wq-advisory",
    });
  }
  if (noSwim) candidates.push({ kind: "closure", icon: "🚫", text: noSwim.title, id: "no-swim" });
  if (flags.includes("double-red")) {
    candidates.push({ kind: "closure", icon: "🚩", text: FLAG_HEADLINE["double-red"], id: "flag-double-red" });
  }
  if (flags.includes("red")) {
    candidates.push({ kind: "redFlagOrRipWarning", icon: "🚩", text: FLAG_HEADLINE.red, id: "flag-red" });
  }
  if (hasRipToShow) {
    // An actual NWS Rip Current Statement/Warning in effect (resolveRipNow's
    // source "alert", always "high") ranks with the red flag; a model/
    // forecast reading is guidance, not a posted statement — softer tier.
    // Mirrors lib/safetyTone.ts's own danger-vs-caution split for rip.
    candidates.push({
      kind: ripNow.source === "alert" ? "redFlagOrRipWarning" : "softAdvisory",
      icon: "🌊",
      text: ripBannerCopy.bannerText,
      id: "rip",
    });
  }
  if (upcomingNonRipAlerts.length) {
    candidates.push({
      kind: "other",
      icon: "🕐",
      text: `${upcomingNonRipAlerts[0].event} begins soon${
        upcomingNonRipAlerts.length > 1 ? ` (+${upcomingNonRipAlerts.length - 1} more)` : ""
      }`,
      id: "upcoming",
    });
  }
  if (flags.includes("purple")) {
    candidates.push({ kind: "other", icon: "🚩", text: FLAG_HEADLINE.purple, id: "flag-purple" });
  }
  if (flags.includes("yellow")) {
    candidates.push({ kind: "other", icon: "🚩", text: FLAG_HEADLINE.yellow, id: "flag-yellow" });
  }
  if (flags.includes("green")) {
    candidates.push({ kind: "other", icon: "🚩", text: FLAG_HEADLINE.green, id: "flag-green" });
  }
  const sections = rankSafetyItems(candidates);
  const headline = sections[0] ?? null;
  const rest = sections.slice(1);
  // Names the next most severe thing (not just a count) — CSS truncation
  // (see the `truncate` span below) is what makes "when it fits" work: it
  // always renders the real next item and lets the line ellipsize it rather
  // than deciding ahead of time whether there's room.
  // Flags always render as their own swatches beside this label (flagsNode),
  // so they're left out of the text count — otherwise "+2 more" just meant
  // the two flag swatches already on screen. They can still be the headline.
  const restText = rest.filter((r) => !r.id.startsWith("flag-"));
  const otherLabel =
    restText.length === 0
      ? null
      : restText.length === 1
        ? restText[0].text
        : `${restText[0].text} +${restText.length - 1} more`;
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
