import type { CamView } from "@/lib/types";
import { fmtTime } from "@/lib/format";
import { RelativeTime, useNowMs } from "@/components/RelativeTime";
import { camFreshness } from "@/lib/camFreshness";

/** Above this, a frozen provider feed reads as "paused", not just "a bit late". */
const FEED_PAUSED_MIN = 30;

/**
 * Time of the still being shown: the source's exact capture time when published
 * (feed cams), otherwise the moment we last refreshed the frame.
 */
function CamStamp({ cam, tz }: { cam: CamView; tz: string }) {
  const exact = cam.capturedAt != null;
  const t = cam.capturedAt ?? cam.weather.fetchedAt;
  return (
    <div
      className="mt-1 text-[11px] text-slate-500"
      title={
        exact
          ? "Image capture time"
          : "This cam publishes no capture time — we can't confirm how current the still is."
      }
    >
      {exact ? (
        <>📷 {fmtTime(t, tz)} · <RelativeTime iso={t} /></>
      ) : (
        <>📷 capture time unknown · fetched {fmtTime(t, tz)}</>
      )}
    </div>
  );
}

/** Big "headline" still-image cam (live JPEG via the same-origin proxy). */
function FeaturedCam({ cam, tz, dataAt }: { cam: CamView; tz: string; dataAt?: string }) {
  // Cache-bust on a new capture (feed cams) or each poll, AND on every data
  // refresh: a refetched snapshot must produce a new image URL even when the
  // provider's capture time hasn't moved, or the browser keeps painting the old
  // JPEG. Cheap — the proxy is edge-cached for 60s.
  const src = `${cam.imageUrl}?t=${encodeURIComponent(
    cam.capturedAt ?? cam.weather.fetchedAt,
  )}&d=${encodeURIComponent(dataAt ?? "")}`;
  // Four honesty states (see lib/camFreshness.ts). The one rule that matters:
  // we only say "Live" when BOTH the capture time and the snapshot this page is
  // holding are recent. A page that failed to refetch, or sat in the background,
  // is showing an old frame no matter what its stored capture time says.
  // Freshness is judged against the client clock only (null until mounted), so
  // the server renders the honest "unverified" state and hydration matches it.
  const now = useNowMs();
  const state = camFreshness({ capturedAt: cam.capturedAt, dataAt, now });
  const captureAgeMin =
    now != null && cam.capturedAt ? (now - Date.parse(cam.capturedAt)) / 60000 : null;
  const stale = state === "feed-stale" || state === "data-stale";
  const dim = stale;
  return (
    <a
      href={cam.url}
      target="_blank"
      rel="noreferrer"
      className="group block overflow-hidden rounded-2xl bg-slate-900 ring-1 ring-slate-900/10 dark:ring-white/10 transition hover:ring-ocean-500/50"
    >
      <div className="relative aspect-video w-full overflow-hidden">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt={`${cam.name} — live`}
          className={`h-full w-full object-cover transition duration-300 group-hover:scale-[1.02] ${
            dim ? "opacity-80" : ""
          }`}
          loading="lazy"
          decoding="async"
        />
        {state === "feed-stale" ? (
          <div className="absolute inset-x-0 bottom-0 bg-slate-950/70 px-2 py-1 text-center text-[11px] text-slate-100">
            {captureAgeMin != null && captureAgeMin > FEED_PAUSED_MIN ? "Feed paused — " : null}
            Last feed {fmtTime(cam.capturedAt as string, tz)} ·{" "}
            <RelativeTime iso={cam.capturedAt as string} />
          </div>
        ) : state === "data-stale" ? (
          <div className="absolute inset-x-0 bottom-0 bg-slate-950/70 px-2 py-1 text-center text-[11px] text-slate-100">
            Refreshing… {dataAt ? <>last data <RelativeTime iso={dataAt} /></> : "last data time unknown"}
          </div>
        ) : state === "unverified" ? (
          <div className="absolute inset-x-0 bottom-0 bg-slate-950/65 px-2 py-1 text-center text-[11px] text-slate-200">
            Snapshot — may be delayed
          </div>
        ) : null}
      </div>
      <div className="p-3 sm:p-4">
        <div className="flex items-center justify-between gap-2">
          <div className="text-base font-semibold text-white sm:text-lg">{cam.name}</div>
          {stale ? (
            <span
              className="shrink-0 rounded-full bg-slate-500/20 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-200"
              title="Time since the still image was last captured — tap for live video."
            >
              📷 <RelativeTime iso={cam.capturedAt as string} />
            </span>
          ) : state === "live" ? (
            <span className="shrink-0 rounded-full bg-rose-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-rose-300">
              ● Live
            </span>
          ) : (
            <span
              className="shrink-0 rounded-full bg-slate-500/20 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-700 dark:text-slate-300"
              title="This cam publishes no capture time, so we can't confirm the still is current — tap for the live video."
            >
              📷 Snapshot
            </span>
          )}
        </div>
        <CamStamp cam={cam} tz={tz} />
      </div>
    </a>
  );
}

/** Embedded live-video cam (e.g. a framing-allowed YouTube stream). */
function VideoCam({ cam }: { cam: CamView }) {
  return (
    <div className="overflow-hidden rounded-2xl bg-slate-900 ring-1 ring-slate-900/10 dark:ring-white/10">
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
      className="flex min-h-[44px] items-center justify-between gap-2 rounded-xl bg-white/80 dark:bg-slate-900/70 px-3 py-2.5 ring-1 ring-slate-900/10 dark:ring-white/10 transition hover:ring-ocean-500/50"
    >
      <span className="min-w-0">
        <span className="block truncate text-sm text-slate-700 dark:text-slate-200">{cam.name}</span>
        <span className="block truncate text-[11px] text-slate-500">{cam.provider}</span>
      </span>
      <span className="shrink-0 text-slate-500" aria-hidden>
        ↗
      </span>
    </a>
  );
}

export function CamGrid({
  cams,
  tz,
  dataAt,
}: {
  cams: CamView[];
  tz: string;
  /** When the snapshot on screen was generated (ISO) — gates the "Live" badge. */
  dataAt?: string;
}) {
  const featured = cams.filter((c) => c.embedType === "image" && c.imageUrl);
  const videos = cams.filter((c) => c.embedType === "iframe");
  const links = cams.filter((c) => c.embedType === "link");
  if (featured.length + videos.length + links.length === 0) return null;

  return (
    <section>
      <h2 className="mb-4 text-lg font-semibold text-slate-900 dark:text-white">Beach &amp; surf cams</h2>

      {featured.length ? (
        <div className="grid gap-4 sm:grid-cols-2">
          {featured.map((cam) => (
            <FeaturedCam key={cam.name} cam={cam} tz={tz} dataAt={dataAt} />
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
