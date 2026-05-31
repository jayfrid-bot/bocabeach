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

/** Big "headline" still-image cam (live JPEG via the same-origin proxy). */
function FeaturedCam({ cam }: { cam: CamView }) {
  // Cache-bust per render so the still refreshes with the dashboard's polling.
  const src = `${cam.imageUrl}?t=${cam.weather.fetchedAt}`;
  return (
    <a
      href={cam.url}
      target="_blank"
      rel="noreferrer"
      className="group block overflow-hidden rounded-2xl bg-slate-900 ring-1 ring-white/10 transition hover:ring-ocean-500/50"
    >
      <div className="aspect-video w-full overflow-hidden">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt={`${cam.name} — live`}
          className="h-full w-full object-cover transition duration-300 group-hover:scale-[1.02]"
          loading="lazy"
        />
      </div>
      <div className="p-3 sm:p-4">
        <div className="flex items-center justify-between gap-2">
          <div className="text-base font-semibold text-white sm:text-lg">{cam.name}</div>
          <span className="shrink-0 rounded-full bg-rose-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-rose-300">
            ● Live
          </span>
        </div>
        <div className="text-xs text-slate-400">{cam.provider}</div>
        <CamWeatherStrip cam={cam} />
        {cam.attribution ? (
          <div className="mt-1 text-[11px] text-slate-500">{cam.attribution}</div>
        ) : null}
      </div>
    </a>
  );
}

/** Embedded live-video cam (e.g. a framing-allowed YouTube stream). */
function VideoCam({ cam }: { cam: CamView }) {
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
      <div className="p-3">
        <div className="text-sm font-medium text-white">{cam.name}</div>
        <div className="text-xs text-slate-400">{cam.provider}</div>
        <CamWeatherStrip cam={cam} />
      </div>
    </div>
  );
}

/** Compact link-out for cams that can't be embedded (kept small at the bottom). */
function LinkChip({ cam }: { cam: CamView }) {
  return (
    <a
      href={cam.url}
      target="_blank"
      rel="noreferrer"
      className="flex min-h-[44px] items-center justify-between gap-2 rounded-xl bg-slate-900/70 px-3 py-2.5 ring-1 ring-white/10 transition hover:ring-ocean-500/50"
    >
      <span className="min-w-0">
        <span className="block truncate text-sm text-slate-200">{cam.name}</span>
        <span className="block truncate text-[11px] text-slate-500">{cam.provider}</span>
      </span>
      <span className="shrink-0 text-slate-500" aria-hidden>
        ↗
      </span>
    </a>
  );
}

export function CamGrid({ cams }: { cams: CamView[] }) {
  const featured = cams.filter((c) => c.embedType === "image" && c.imageUrl);
  const videos = cams.filter((c) => c.embedType === "iframe");
  const links = cams.filter((c) => c.embedType === "link");
  if (featured.length + videos.length + links.length === 0) return null;

  return (
    <section>
      <h2 className="text-lg font-semibold text-white">Beach &amp; surf cams</h2>
      <p className="mb-4 mt-1 text-xs text-slate-500">
        Live weather &amp; wind shown per cam, from Open-Meteo at each spot.
      </p>

      {featured.length ? (
        <div className="grid gap-4 sm:grid-cols-2">
          {featured.map((cam) => (
            <FeaturedCam key={cam.name} cam={cam} />
          ))}
        </div>
      ) : null}

      {videos.length ? (
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {videos.map((cam) => (
            <VideoCam key={cam.name} cam={cam} />
          ))}
        </div>
      ) : null}

      {links.length ? (
        <div className="mt-5">
          <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-500">
            More cams (link out)
          </h3>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {links.map((cam) => (
              <LinkChip key={cam.name} cam={cam} />
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}
