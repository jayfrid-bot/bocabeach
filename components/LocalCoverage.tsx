import type { LocationPublic } from "@/lib/types";
import { stateCodeFromRegion, stateProgram } from "@/lib/stateBeachPrograms";

/**
 * Honest "what's tracked here" card for auto-resolved beaches. The national data
 * layers (weather, surf, tides, UV, air, NWS alerts/rip) all resolve from
 * lat/lon, but a few hyper-local sources are curated by hand and aren't wired up
 * for an auto beach yet. Rather than render a bare "—", we say so plainly and
 * point at the real alternative (NWS hazards above, the state water program).
 *
 * Renders nothing for curated beaches (tier !== "auto"), so Boca is unaffected.
 */
export function LocalCoverage({
  location,
  hasCams,
}: {
  location: LocationPublic;
  hasCams: boolean;
}) {
  if (location.tier !== "auto") return null;
  const program = stateProgram(stateCodeFromRegion(location.region));

  return (
    <div className="rounded-2xl bg-white/80 dark:bg-slate-900/70 p-4 ring-1 ring-slate-900/10 dark:ring-white/10">
      <div className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400">
        <span aria-hidden>🧭</span>
        <span>Local coverage</span>
      </div>
      <p className="mt-1 text-xs text-slate-500">
        Live weather, surf, tides, UV, air quality and NWS safety alerts are tracked
        here. A few hyper-local sources aren&apos;t wired up for this beach yet:
      </p>
      <ul className="mt-2 space-y-1.5 text-sm text-slate-700 dark:text-slate-200">
        <li className="flex gap-2">
          <span aria-hidden>🚩</span>
          <span>
            <span className="font-medium">Lifeguard flags</span> aren&apos;t posted for
            this beach yet — rely on the NWS Beach Hazards &amp; rip-current signals above.
          </span>
        </li>
        <li className="flex gap-2">
          <span aria-hidden>🧫</span>
          <span>
            <span className="font-medium">Water-quality advisories</span>:{" "}
            {program ? (
              <a
                href={program.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-ocean-700 underline dark:text-ocean-300"
              >
                check the {program.name} ↗
              </a>
            ) : (
              "check your state's beach-monitoring program."
            )}
          </span>
        </li>
        {!hasCams ? (
          <li className="flex gap-2">
            <span aria-hidden>📷</span>
            <span>
              <span className="font-medium">Beach cams</span> haven&apos;t been added for
              this beach yet.
            </span>
          </li>
        ) : null}
      </ul>
    </div>
  );
}
