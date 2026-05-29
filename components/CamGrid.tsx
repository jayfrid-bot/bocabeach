import type { CamView } from "@/lib/types";

function CamWeatherStrip({ cam }: { cam: CamView }) {
  const w = cam.weather.data;
  if (!w) {
    return (
      <div className="mt-2 text-[11px] text-slate-500">live weather unavailable</div>
    );
  }
  const wind =
    w.windSpeedMph != null
      ? `${w.windSpeedMph} mph${w.windDirCardinal ? " " + w.windDirCardinal : ""}` +
        (w.windGustMph != null ? ` · gusts ${w.windGustMph}` : "")
      : null;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-300">
      {w.airTempF != null ? (
        <span title="Air temperature">
          🌡️ {w.airTempF}°F
          {w.apparentTempF != null && w.apparentTempF !== w.airTempF
            ? ` (feels ${w.apparentTempF}°)`
            : ""}
        </span>
      ) : null}
      {wind ? <span title="Wind">💨 {wind}</span> : null}
      {w.shortForecast ? <span className="text-slate-400">{w.shortForecast}</span> : null}
    </div>
  );
}

function CamFooter({ cam }: { cam: CamView }) {
  return (
    <div className="p-3">
      <div className="text-sm font-medium text-white">{cam.name}</div>
      <div className="text-xs text-slate-400">{cam.provider}</div>
      <CamWeatherStrip cam={cam} />
      {cam.attribution ? (
        <div className="mt-1 text-[11px] text-slate-500">{cam.attribution}</div>
      ) : null}
    </div>
  );
}

function CamCard({ cam }: { cam: CamView }) {
  if (cam.embedType === "iframe") {
    return (
      <div className="overflow-hidden rounded-2xl bg-slate-900 ring-1 ring-white/10">
        <div className="aspect-video">
          <iframe
            src={cam.url}
            title={cam.name}
            className="h-full w-full"
            allow="accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture"
            referrerPolicy="strict-origin-when-cross-origin"
            allowFullScreen
            loading="lazy"
          />
        </div>
        <CamFooter cam={cam} />
      </div>
    );
  }

  if (cam.embedType === "image") {
    return (
      <a
        href={cam.url}
        target="_blank"
        rel="noreferrer"
        className="block overflow-hidden rounded-2xl bg-slate-900 ring-1 ring-white/10"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={cam.url} alt={cam.name} className="aspect-video w-full object-cover" />
        <CamFooter cam={cam} />
      </a>
    );
  }

  return (
    <a
      href={cam.url}
      target="_blank"
      rel="noreferrer"
      className="group flex flex-col justify-between rounded-2xl bg-slate-900/70 p-4 ring-1 ring-white/10 transition hover:ring-ocean-500/50"
    >
      <div className="flex items-center justify-between">
        <span className="text-2xl" aria-hidden>
          📷
        </span>
        <span className="text-slate-500 transition group-hover:text-ocean-300">↗</span>
      </div>
      <div className="mt-3">
        <div className="text-sm font-medium text-white">{cam.name}</div>
        <div className="text-xs text-slate-400">{cam.provider}</div>
        <CamWeatherStrip cam={cam} />
        {cam.attribution ? (
          <div className="mt-1 text-[11px] text-slate-500">{cam.attribution}</div>
        ) : null}
      </div>
    </a>
  );
}

export function CamGrid({ cams }: { cams: CamView[] }) {
  if (cams.length === 0) return null;
  return (
    <section>
      <h2 className="mb-3 text-lg font-semibold text-white">Beach &amp; surf cams</h2>
      <p className="mb-3 text-xs text-slate-500">
        Live weather &amp; wind shown per cam, from Open-Meteo at each spot.
      </p>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {cams.map((cam) => (
          <CamCard key={cam.name} cam={cam} />
        ))}
      </div>
    </section>
  );
}
