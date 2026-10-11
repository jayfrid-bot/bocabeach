"use client";

/**
 * The Plus day view: pick a past day and see how it looked. A tall bottom
 * sheet (docs/CAM_ARCHIVE_PLAN.md R11), webcams first:
 *
 *   1. the day's best score, the formula note when one is needed;
 *   2. one camera at a time: camera chips, ONE picture, a slider over that
 *      camera's saved shots for the day, the credit line, tap for full screen;
 *   3. the hour-by-hour score strip (same colors as the hourly chart);
 *   4. the readings for the selected hour.
 *
 * One value drives it all: the selected hour (`hourUtc`). The slider, the hour
 * strip and the full-screen arrows all move it, and every camera shows the shot
 * closest to it. A camera with no shot in that hour says which shot it is
 * showing ("Closest shot: 1:42 PM"). Only the shot on screen loads, plus its
 * next and previous neighbours.
 *
 * Picture links last 15 minutes. When a picture will not load, the day is
 * fetched once more for fresh links (at most once a minute), then the picture
 * says it is unavailable. Pure logic is in lib/plus/dayView.ts.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Sheet } from "@/components/plus/Sheet";
import { scoreColor } from "@/lib/format";
import { plusApi, plusErrorMessage, type HistoryDayResult } from "@/lib/plus/api";
import { bootstrapInstallToken } from "@/lib/plus/client";
import { formulaChangeNotice } from "@/lib/plus/formulaNotice";
import {
  bestLine,
  closestShotText,
  dayTitle,
  defaultCamId,
  defaultHourUtc,
  emptyCamText,
  hour12Compact,
  hour12Label,
  nearestFrameIndex,
  readingTiles,
  sliderLabel,
  stepDate,
} from "@/lib/plus/dayView";
import type { DayCam, DayFrame, DayViewPayload } from "@/lib/history/dayView";

/** A refetch for fresh picture links is allowed at most this often. */
const REFETCH_GAP_MS = 60_000;

/** Fetch one day; on a 401 re-mint the install token ONCE and retry (same shape as HistorySection). */
async function fetchDayWithRetry(slug: string, deviceId: string, date: string): Promise<HistoryDayResult> {
  const first = await plusApi.fetchHistoryDay(slug, deviceId, date);
  if (first.status !== 401) return first;
  const { token } = await bootstrapInstallToken({ forceRefresh: true });
  if (!token) return first;
  return plusApi.fetchHistoryDay(slug, deviceId, date);
}

type DayState =
  | { kind: "loading" }
  | { kind: "error"; error: string }
  | { kind: "ready"; day: DayViewPayload };

/** Loads `date`, and again on `refresh()`. A refresh keeps the day on screen until the new one lands. */
export function useDay(slug: string, deviceId: string, date: string) {
  const [state, setState] = useState<DayState>({ kind: "loading" });
  const [nonce, setNonce] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const loadedDate = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const isRefresh = loadedDate.current === date;
    if (isRefresh) setRefreshing(true);
    else setState({ kind: "loading" });
    void fetchDayWithRetry(slug, deviceId, date).then((res) => {
      if (cancelled) return;
      setRefreshing(false);
      if (res.ok) {
        loadedDate.current = date;
        setState({ kind: "ready", day: res.day });
      } else if (!isRefresh) {
        setState({ kind: "error", error: res.error });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [slug, deviceId, date, nonce]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  return { state, refresh, refreshing };
}

const CARD = "rounded-2xl bg-white/80 ring-1 ring-slate-900/10 dark:bg-slate-900/70 dark:ring-white/10";
const ICON_BTN =
  "inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-slate-900/5 text-lg text-slate-700 transition hover:bg-slate-900/10 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-white/10 dark:text-slate-200 dark:hover:bg-white/20";

export function DayViewSheet({
  slug,
  deviceId,
  date,
  min,
  max,
  onStep,
  onClose,
}: {
  slug: string;
  deviceId: string;
  /** The day on screen, YYYY-MM-DD in the beach's timezone. */
  date: string;
  /** First and last day the picker allows (the first archived day, and today). */
  min: string | null;
  max: string | null;
  onStep: (date: string) => void;
  onClose: () => void;
}) {
  const { state, refresh, refreshing } = useDay(slug, deviceId, date);
  const prev = stepDate(date, -1, min, max);
  const next = stepDate(date, 1, min, max);

  return (
    <Sheet open title={dayTitle(date)} onClose={onClose} tall>
      <div className="flex items-center justify-between gap-2">
        <button type="button" className={ICON_BTN} aria-label="Previous day" disabled={!prev} onClick={() => prev && onStep(prev)}>
          <span aria-hidden>{"‹"}</span>
        </button>
        <p className="min-w-0 flex-1 text-center text-sm font-medium text-slate-700 dark:text-slate-200">
          {state.kind === "ready" ? bestLine(state.day) : " "}
        </p>
        <button type="button" className={ICON_BTN} aria-label="Next day" disabled={!next} onClick={() => next && onStep(next)}>
          <span aria-hidden>{"›"}</span>
        </button>
      </div>

      {state.kind === "loading" ? (
        <p className="mt-4 text-sm text-slate-500 dark:text-slate-400" role="status">
          Loading this day…
        </p>
      ) : state.kind === "error" ? (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <p role="alert" className="text-sm text-slate-600 dark:text-slate-400">
            {state.error === "bad-request" ? "That day isn’t available." : plusErrorMessage(state.error)}
          </p>
          <button
            type="button"
            onClick={refresh}
            className="inline-flex min-h-[44px] items-center rounded-full bg-slate-900/5 px-4 text-sm font-medium text-slate-700 transition hover:bg-slate-900/10 dark:bg-white/10 dark:text-slate-200 dark:hover:bg-white/20"
          >
            Try again
          </button>
        </div>
      ) : (
        <DayBody day={state.day} refreshing={refreshing} onLinksExpired={refresh} />
      )}
    </Sheet>
  );
}

function DayBody({
  day,
  refreshing,
  onLinksExpired,
}: {
  day: DayViewPayload;
  refreshing: boolean;
  onLinksExpired: () => void;
}) {
  // The selected hour is remembered with its date, so a new day starts fresh
  // (its best hour) while a refetch of the same day keeps your place.
  const [hourSel, setHourSel] = useState<{ date: string; hourUtc: string | null } | null>(null);
  const hourUtc = hourSel && hourSel.date === day.date ? hourSel.hourUtc : defaultHourUtc(day);
  const selectHour = useCallback((h: string | null) => setHourSel({ date: day.date, hourUtc: h }), [day.date]);

  // The camera is kept across days when the next day has it too.
  const [camPref, setCamPref] = useState<string | null>(null);
  const camId = day.cams.some((c) => c.id === camPref) ? camPref : defaultCamId(day);
  const cam = day.cams.find((c) => c.id === camId) ?? null;

  const formulaNotice = formulaChangeNotice(day.versions);
  const selectedHour = day.hours.find((h) => h.hourUtc === hourUtc) ?? null;

  return (
    <div className="mt-3 space-y-5">
      {formulaNotice ? <p className="text-xs text-slate-500 dark:text-slate-400">{formulaNotice}</p> : null}
      {day.summary.partial && day.summary.hours > 0 ? (
        <p className="text-xs text-amber-700 dark:text-amber-400">Partial day: we saved only a few hours of scores.</p>
      ) : null}

      {day.cams.length > 0 ? (
        <CamViewer
          cams={day.cams}
          cam={cam}
          framesStart={day.framesStart}
          hourUtc={hourUtc}
          refreshing={refreshing}
          onPickCam={setCamPref}
          onPickHour={selectHour}
          onLinksExpired={onLinksExpired}
        />
      ) : null}

      <section aria-labelledby="day-hours-heading">
        <h3 id="day-hours-heading" className="mb-2 text-sm font-semibold text-slate-700 dark:text-slate-300">
          Hour by hour
        </h3>
        {day.hours.length === 0 ? (
          <p className="text-sm text-slate-600 dark:text-slate-400">We have no scores saved for this day.</p>
        ) : (
          <HourStrip hours={day.hours} selected={hourUtc} onPick={selectHour} />
        )}
      </section>

      <section aria-labelledby="day-readings-heading">
        <h3 id="day-readings-heading" className="mb-2 text-sm font-semibold text-slate-700 dark:text-slate-300">
          {selectedHour ? `Readings at ${hour12Label(selectedHour.localHour)}` : "Readings"}
        </h3>
        {!selectedHour && day.hours.length > 0 ? (
          <p className="mb-2 text-xs text-slate-500 dark:text-slate-400">We have no readings saved for that hour.</p>
        ) : null}
        <dl className="grid grid-cols-3 gap-2">
          {readingTiles(selectedHour).map((t) => (
            <div key={t.key} className={`${CARD} min-w-0 px-2 py-2 text-center`}>
              <dt className="truncate text-[11px] text-slate-500 dark:text-slate-400">{t.label}</dt>
              <dd className="mt-0.5 truncate text-sm font-semibold tabular-nums text-slate-900 dark:text-white">{t.value}</dd>
            </div>
          ))}
        </dl>
      </section>
    </div>
  );
}

function HourStrip({
  hours,
  selected,
  onPick,
}: {
  hours: DayViewPayload["hours"];
  selected: string | null;
  onPick: (hourUtc: string) => void;
}) {
  const box = useRef<HTMLDivElement | null>(null);
  // Keep the selected hour in view without scrolling the sheet itself.
  useEffect(() => {
    const el = box.current;
    const btn = el?.querySelector<HTMLElement>('[aria-pressed="true"]');
    if (!el || !btn) return;
    el.scrollTo({ left: btn.offsetLeft - el.clientWidth / 2 + btn.clientWidth / 2, behavior: "smooth" });
  }, [selected]);

  return (
    <div ref={box} className="relative flex gap-1 overflow-x-auto pb-1" role="group" aria-label="Hours of the day">
      {hours.map((h) => {
        const on = h.hourUtc === selected;
        return (
          <button
            key={h.hourUtc}
            type="button"
            aria-pressed={on}
            aria-label={`${hour12Label(h.localHour)}, ${h.score == null ? "no score" : `score ${h.score}`}`}
            onClick={() => onPick(h.hourUtc)}
            className={`flex min-h-[60px] min-w-[44px] shrink-0 flex-col items-center justify-center gap-1 rounded-xl px-1 py-1 transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ocean-500 ${
              on ? "bg-ocean-500/15 ring-2 ring-ocean-500 dark:ring-ocean-400" : "hover:bg-slate-900/5 dark:hover:bg-white/10"
            }`}
          >
            <span
              aria-hidden
              className={`flex h-8 w-8 items-center justify-center rounded-full text-xs font-bold tabular-nums text-slate-950 ${
                h.score == null ? "bg-slate-200 text-slate-500 dark:bg-slate-800" : ""
              }`}
              style={h.score == null ? undefined : { background: scoreColor(h.score) }}
            >
              {h.score == null ? "–" : h.score}
            </span>
            <span aria-hidden className="text-[10px] tabular-nums text-slate-600 dark:text-slate-300">
              {hour12Compact(h.localHour)}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function CamViewer({
  cams,
  cam,
  framesStart,
  hourUtc,
  refreshing,
  onPickCam,
  onPickHour,
  onLinksExpired,
}: {
  cams: DayCam[];
  cam: DayCam | null;
  framesStart: string | null;
  hourUtc: string | null;
  refreshing: boolean;
  onPickCam: (id: string) => void;
  onPickHour: (hourUtc: string) => void;
  onLinksExpired: () => void;
}) {
  const frames = useMemo(() => cam?.frames ?? [], [cam]);
  const idx = nearestFrameIndex(frames, hourUtc);
  const frame: DayFrame | null = idx >= 0 ? frames[idx] : null;
  const prevFrame = idx > 0 ? frames[idx - 1] : null;
  const nextFrame = idx >= 0 && idx < frames.length - 1 ? frames[idx + 1] : null;

  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const [full, setFull] = useState(false);
  const lastRefetch = useRef(0);

  // Warm the neighbours only: never the whole day.
  const prevUrl = prevFrame?.url ?? null;
  const nextUrl = nextFrame?.url ?? null;
  useEffect(() => {
    for (const u of [prevUrl, nextUrl]) {
      if (!u) continue;
      const im = new Image();
      im.src = u;
    }
  }, [prevUrl, nextUrl]);

  const onImgError = useCallback(() => {
    if (!frame) return;
    setFailedSrc(frame.url);
    if (Date.now() - lastRefetch.current > REFETCH_GAP_MS) {
      lastRefetch.current = Date.now();
      onLinksExpired();
    }
  }, [frame, onLinksExpired]);

  const go = useCallback(
    (to: number) => {
      const f = frames[to];
      if (f) onPickHour(f.hourUtc);
    },
    [frames, onPickHour],
  );

  const gapText = closestShotText(frame, hourUtc);
  const loaded = !!frame && loadedSrc === frame.url;
  const failed = !!frame && failedSrc === frame.url && !refreshing;

  return (
    <section aria-labelledby="day-cams-heading">
      <h3 id="day-cams-heading" className="mb-2 text-sm font-semibold text-slate-700 dark:text-slate-300">
        Beach cams
      </h3>

      <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-2" role="group" aria-label="Cameras">
        {cams.map((c) => {
          const on = c.id === cam?.id;
          return (
            <button
              key={c.id}
              type="button"
              aria-pressed={on}
              onClick={() => onPickCam(c.id)}
              className={`inline-flex min-h-[44px] shrink-0 items-center whitespace-nowrap rounded-full px-4 text-sm font-medium ring-1 transition ${
                on
                  ? "bg-ocean-500/20 text-ocean-800 ring-ocean-500/40 dark:text-ocean-200"
                  : "bg-slate-900/5 text-slate-700 ring-slate-900/10 hover:bg-slate-900/10 dark:bg-white/5 dark:text-slate-200 dark:ring-white/10 dark:hover:bg-white/10"
              }`}
            >
              {c.name}
            </button>
          );
        })}
      </div>

      {!frame ? (
        <div className="flex aspect-video w-full items-center justify-center rounded-2xl bg-slate-100 px-6 text-center dark:bg-slate-800/60">
          <p className="text-sm text-slate-600 dark:text-slate-300">{emptyCamText(framesStart)}</p>
        </div>
      ) : (
        <>
          <button
            type="button"
            onClick={() => setFull(true)}
            aria-label={`${cam?.name ?? "Camera"}, ${frame.displayAtLocal}. Open full screen.`}
            className="relative block aspect-video w-full overflow-hidden rounded-2xl bg-slate-200 ring-1 ring-slate-900/10 dark:bg-slate-800 dark:ring-white/10"
          >
            {!loaded && !failed ? <span aria-hidden className="absolute inset-0 animate-pulse bg-slate-300/60 dark:bg-slate-700/60" /> : null}
            {failed ? (
              <span className="absolute inset-0 flex items-center justify-center px-6 text-center text-sm text-slate-600 dark:text-slate-300">
                This shot isn&apos;t available right now.
              </span>
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={frame.url}
                src={frame.url}
                alt=""
                decoding="async"
                onLoad={() => setLoadedSrc(frame.url)}
                onError={onImgError}
                className={`absolute inset-0 h-full w-full object-cover transition-opacity ${loaded ? "opacity-100" : "opacity-0"}`}
              />
            )}
          </button>

          <p className="mt-2 text-sm font-medium tabular-nums text-slate-800 dark:text-slate-100" aria-live="polite">
            {gapText ?? frame.displayAtLocal}
          </p>

          {frames.length > 1 ? (
            <div className="mt-1">
              <input
                type="range"
                min={0}
                max={frames.length - 1}
                step={1}
                value={idx}
                onChange={(e) => go(Number(e.target.value))}
                aria-label={`Time of ${cam?.name ?? "camera"} shot`}
                aria-valuetext={sliderLabel(frame.displayAtLocal)}
                className="h-11 w-full cursor-pointer accent-ocean-600"
              />
              <div className="flex justify-between text-[11px] tabular-nums text-slate-500 dark:text-slate-400" aria-hidden>
                <span>{sliderLabel(frames[0].displayAtLocal)}</span>
                <span>{sliderLabel(frames[frames.length - 1].displayAtLocal)}</span>
              </div>
            </div>
          ) : null}

          {frame.attribution ? (
            <p className="mt-1 text-[11px] leading-snug text-slate-500 dark:text-slate-400">{frame.attribution}</p>
          ) : null}

          {full ? (
            <FullScreenFrame
              camName={cam?.name ?? "Camera"}
              frame={frame}
              gapText={gapText}
              hasPrev={idx > 0}
              hasNext={idx < frames.length - 1}
              onPrev={() => go(idx - 1)}
              onNext={() => go(idx + 1)}
              onImgError={onImgError}
              onClose={() => setFull(false)}
            />
          ) : null}
        </>
      )}
    </section>
  );
}

function FullScreenFrame({
  camName,
  frame,
  gapText,
  hasPrev,
  hasNext,
  onPrev,
  onNext,
  onImgError,
  onClose,
}: {
  camName: string;
  frame: DayFrame;
  gapText: string | null;
  hasPrev: boolean;
  hasNext: boolean;
  onPrev: () => void;
  onNext: () => void;
  onImgError: () => void;
  onClose: () => void;
}) {
  const root = useRef<HTMLDivElement | null>(null);
  const handlers = useRef({ onPrev, onNext, onClose, hasPrev, hasNext });
  handlers.current = { onPrev, onNext, onClose, hasPrev, hasNext };

  // Own the keyboard while open. Capture phase on window, so Escape closes this
  // viewer only (not the sheet under it) and Tab cannot leave it.
  useEffect(() => {
    const opener = document.activeElement;
    root.current?.querySelector<HTMLElement>("button")?.focus();
    const onKey = (e: KeyboardEvent) => {
      const h = handlers.current;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        h.onClose();
      } else if (e.key === "ArrowLeft" && h.hasPrev) {
        e.preventDefault();
        h.onPrev();
      } else if (e.key === "ArrowRight" && h.hasNext) {
        e.preventDefault();
        h.onNext();
      } else if (e.key === "Tab") {
        const items = Array.from(root.current?.querySelectorAll<HTMLElement>("button:not([disabled])") ?? []);
        if (items.length === 0) return;
        e.stopPropagation();
        e.stopImmediatePropagation();
        const first = items[0];
        const last = items[items.length - 1];
        const active = document.activeElement;
        if (e.shiftKey && (active === first || !root.current?.contains(active))) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && (active === last || !root.current?.contains(active))) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      if (opener instanceof HTMLElement) opener.focus();
    };
  }, []);

  const NAV =
    "flex h-12 w-12 items-center justify-center rounded-full bg-white/15 text-2xl text-white transition hover:bg-white/25 disabled:opacity-30";
  return (
    <div
      ref={root}
      role="dialog"
      aria-modal="true"
      aria-label={`${camName}, ${frame.displayAtLocal}`}
      className="fixed inset-0 z-[60] flex flex-col bg-black pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)]"
    >
      <div className="flex items-center justify-between gap-3 px-4 py-2 text-white">
        <p className="min-w-0 flex-1 truncate text-sm font-medium">
          {camName} {"·"} {gapText ?? frame.displayAtLocal}
        </p>
        <button type="button" onClick={onClose} aria-label="Close full screen" className={NAV}>
          <span aria-hidden>{"✕"}</span>
        </button>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center px-2">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={frame.url}
          alt={`${camName}, ${frame.displayAtLocal}`}
          onError={onImgError}
          className="max-h-full max-w-full object-contain"
        />
      </div>
      <div className="flex items-center justify-between gap-3 px-4 py-3 text-white">
        <button type="button" onClick={onPrev} disabled={!hasPrev} aria-label="Earlier shot" className={NAV}>
          <span aria-hidden>{"‹"}</span>
        </button>
        <p className="min-w-0 flex-1 text-center text-[11px] leading-snug text-white/70">{frame.attribution ?? ""}</p>
        <button type="button" onClick={onNext} disabled={!hasNext} aria-label="Later shot" className={NAV}>
          <span aria-hidden>{"›"}</span>
        </button>
      </div>
    </div>
  );
}
