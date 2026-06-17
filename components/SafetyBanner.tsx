import type {
  CityOfficialData,
  LightningData,
  NwsData,
  WaterQualityData,
  Wrapped,
} from "@/lib/types";
import { fmtDate } from "@/lib/format";
import { degToCardinal } from "@/lib/util";
import { LifeguardFlag } from "@/components/LifeguardFlag";

export function SafetyBanner({
  city,
  water,
  lightning,
  nws,
  timezone = "America/New_York",
}: {
  city: Wrapped<CityOfficialData>;
  water?: Wrapped<WaterQualityData>;
  lightning?: Wrapped<LightningData>;
  nws?: Wrapped<NwsData>;
  /** Beach IANA timezone, so alert end-times read in local time nationwide. */
  timezone?: string;
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
  const rip = nws?.data?.ripCurrentRisk ?? "unknown";
  const alerts = nws?.data?.alerts ?? [];
  // A NWS Beach Hazards Statement is the national "is it safe to swim" signal —
  // the honest substitute where local lifeguard flags aren't tracked. Pull it
  // (and rip-current statements, the alert form of the rip signal) out of the
  // generic alert list and give it its own elevated, swimmer-focused block.
  const beachHazards = alerts.filter((a) =>
    /beach hazard|rip current statement/i.test(a.event),
  );
  const otherAlerts = alerts.filter(
    (a) => !/beach hazard|rip current statement/i.test(a.event),
  );
  const ripWarn = rip === "high" || rip === "moderate";
  const flags = data?.flags.filter((f) => f !== "unknown") ?? [];
  const hasWarning =
    advisory ||
    lightningDanger ||
    !!noSwim ||
    rip === "high" ||
    alerts.length > 0 ||
    flags.some((f) => ["red", "double-red"].includes(f));

  // Nothing worth surfacing in the safety header. Marine life and posted
  // hazards now live in their own LifeguardReport card lower on the page —
  // they don't gate this banner.
  if (
    !advisory &&
    !lightningDanger &&
    !noSwim &&
    !ripWarn &&
    alerts.length === 0 &&
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
      className={`rounded-2xl p-4 ring-1 ${
        hasWarning ? "bg-rose-500/10 ring-rose-500/40" : "bg-white/80 dark:bg-slate-900/70 ring-slate-900/10 dark:ring-white/10"
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

      {ripWarn || otherAlerts.length ? (
        <div
          className={`mb-3 rounded-xl p-3 ring-1 ${
            rip === "high"
              ? "bg-rose-500/15 ring-rose-500/40"
              : "bg-amber-500/10 ring-amber-500/30"
          }`}
        >
          {rip !== "unknown" ? (
            <div
              className={`flex items-center gap-2 text-sm font-semibold ${RIP_TEXT[rip]}`}
            >
              <span aria-hidden>🌊</span>
              <span>Rip current risk: {rip.toUpperCase()}</span>
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

      {data ? (
        <>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <span className="text-sm font-medium text-slate-700 dark:text-slate-200">
              Lifeguard flags:
            </span>
            {flags.length === 0 ? (
              <span className="text-sm text-slate-600 dark:text-slate-400">none reported</span>
            ) : (
              flags.map((f) => <LifeguardFlag key={f} flag={f} />)
            )}
          </div>

        </>
      ) : null}
    </div>
  );
}
