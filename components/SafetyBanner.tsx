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

  return (
    <div
      className={`rounded-2xl p-3 ring-1 sm:p-4 ${
        tone === "danger"
          ? "bg-rose-500/10 ring-rose-500/40"
          : tone === "caution"
            ? "bg-amber-500/10 ring-amber-500/30"
            : "bg-white/80 dark:bg-slate-900/70 ring-slate-900/10 dark:ring-white/10"
      }`}
    >
      {advisory ? (
        <div className="mb-3 rounded-xl bg-rose-500/15 p-3 ring-1 ring-rose-500/40">
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
        <div className="mb-3 rounded-xl bg-rose-500/15 p-3 ring-1 ring-rose-500/40">
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
        <div className="mb-3 rounded-xl bg-rose-500/15 p-3 ring-1 ring-rose-500/40">
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
        <div className="mb-3 rounded-xl bg-amber-500/15 p-3 ring-1 ring-amber-500/40">
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
        <div className="mb-3 rounded-xl bg-slate-500/10 p-3 ring-1 ring-slate-500/30">
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
          className={`mb-3 rounded-xl p-3 ring-1 ${
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

      {/* One slim inline row — label and flag(s) on the same baseline. The tall
          flying-flag graphic turned a single fact into a half-empty slab when
          it was the only thing this banner had to say. */}
      {data ? (
        // One line at every width: shorter label, no wrapping, and the last
        // flag's text truncates rather than dropping to a second line.
        <div className="flex min-w-0 flex-nowrap items-center gap-x-2.5 overflow-hidden text-xs sm:gap-x-3 sm:text-sm">
          <span className="shrink-0 font-medium text-slate-700 dark:text-slate-200">Flags:</span>
          {flags.length === 0 ? (
            <span className="text-slate-600 dark:text-slate-400">none reported</span>
          ) : (
            flags.map((f) => <LifeguardFlag key={f} flag={f} inline />)
          )}
        </div>
      ) : null}
    </div>
  );
}
