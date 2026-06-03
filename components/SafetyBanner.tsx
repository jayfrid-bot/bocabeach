import type {
  CityOfficialData,
  FlagColor,
  LightningData,
  WaterQualityData,
  Wrapped,
} from "@/lib/types";
import { fmtDate } from "@/lib/format";

const FLAG_STYLE: Record<FlagColor, { bg: string; label: string }> = {
  green: { bg: "#16a34a", label: "Green — low hazard" },
  yellow: { bg: "#eab308", label: "Yellow — moderate surf/currents" },
  red: { bg: "#dc2626", label: "Red — high hazard" },
  "double-red": { bg: "#7f1d1d", label: "Double Red — water closed" },
  purple: { bg: "#9333ea", label: "Purple — dangerous marine life" },
  unknown: { bg: "#475569", label: "Flag status unavailable" },
};

export function SafetyBanner({
  city,
  water,
  lightning,
}: {
  city: Wrapped<CityOfficialData>;
  water?: Wrapped<WaterQualityData>;
  lightning?: Wrapped<LightningData>;
}) {
  const data = city.data;
  const wq = water?.data;
  const advisory = wq?.advisory ?? false;
  const lt = lightning?.data;
  // Lightning within ~10 mi during the scanned window → get out of the water.
  const lightningDanger = (lt?.within10mi ?? 0) > 0;
  const noSwim = data?.noSwimAdvisory;
  const flags = data?.flags.filter((f) => f !== "unknown") ?? [];
  const hasWarning =
    advisory ||
    lightningDanger ||
    !!noSwim ||
    flags.some((f) => ["red", "double-red", "purple"].includes(f));

  // Nothing worth surfacing: no flags, no hazards, no advisory, no close strikes.
  if (
    !advisory &&
    !lightningDanger &&
    !noSwim &&
    flags.length === 0 &&
    (data?.hazards?.length ?? 0) === 0
  ) {
    return null;
  }

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
        hasWarning ? "bg-rose-500/10 ring-rose-500/40" : "bg-slate-900/70 ring-white/10"
      }`}
    >
      {advisory ? (
        <div className="mb-3 rounded-xl bg-rose-500/15 p-3 ring-1 ring-rose-500/40">
          <div className="flex items-center gap-2 text-sm font-semibold text-rose-200">
            <span aria-hidden>🧫</span>
            <span>Water quality advisory — swimming not recommended</span>
          </div>
          <div className="mt-1 text-xs text-rose-100/80">
            High enterococci bacteria
            {badSites.length ? ` at ${badSites.map((s) => s.name).join(", ")}` : ""}.
            {sampledAt ? ` Sampled ${fmtDate(sampledAt, "UTC")}.` : ""}{" "}
            {water?.attribution ?? "Florida Healthy Beaches"}.
          </div>
        </div>
      ) : null}

      {noSwim ? (
        <div className="mb-3 rounded-xl bg-rose-500/15 p-3 ring-1 ring-rose-500/40">
          <div className="flex items-center gap-2 text-sm font-semibold text-rose-200">
            <span aria-hidden>🚫</span>
            <span>{noSwim.title}</span>
          </div>
          <div className="mt-1 text-xs text-rose-100/80">
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
          <div className="flex items-center gap-2 text-sm font-semibold text-rose-200">
            <span aria-hidden>⛈️</span>
            <span>Lightning nearby — get out of the water and seek shelter</span>
          </div>
          <div className="mt-1 text-xs text-rose-100/80">
            {lt?.within10mi} strike{(lt?.within10mi ?? 0) === 1 ? "" : "s"} within 10
            mi in the last {lt?.windowMinutes ?? 30} min
            {lt?.nearestMi != null ? ` (nearest ${lt.nearestMi} mi).` : "."} NOAA
            GOES GLM.
          </div>
        </div>
      ) : null}

      {data ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-slate-200">
              Lifeguard flags:
            </span>
            {flags.length === 0 ? (
              <span className="text-sm text-slate-400">none reported</span>
            ) : (
              flags.map((f) => (
                <span
                  key={f}
                  className="rounded-full px-2.5 py-0.5 text-xs font-semibold text-white"
                  style={{ background: FLAG_STYLE[f].bg }}
                >
                  {FLAG_STYLE[f].label}
                </span>
              ))
            )}
          </div>

          {data.marineLife?.length || data.hazards?.length ? (
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-400">
              {data.marineLife?.length ? (
                <span>🪼 {data.marineLife.join(", ")}</span>
              ) : null}
              {data.hazards?.length ? <span>⚠ {data.hazards.join(", ")}</span> : null}
            </div>
          ) : null}

          <div className="mt-2 text-xs text-slate-500">
            Official report from {city.attribution}
            {data.updatedLabel ? ` · ${data.updatedLabel}` : ""}. Always heed posted
            signs and lifeguards.
          </div>
        </>
      ) : null}
    </div>
  );
}
