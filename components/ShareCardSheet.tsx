"use client";

import { useCallback, useState } from "react";
import { Sheet, PrimaryButton, ErrorLine } from "@/components/plus/Sheet";

interface FormatDef {
  key: "story" | "square";
  label: string;
  width: number;
  height: number;
}

const FORMATS: FormatDef[] = [
  { key: "story", label: "Story (1080×1920)", width: 1080, height: 1920 },
  { key: "square", label: "Square (1080×1080)", width: 1080, height: 1080 },
];

type FormatKey = FormatDef["key"];

/** A `navigator.share`/`canShare` shape narrower than the DOM lib's own —
 *  older TS DOM libs don't type `files` on ShareData/canShare consistently
 *  across targets, so this pins exactly what we call. */
interface FileShareNavigator {
  canShare?: (data: { files?: File[] }) => boolean;
  share?: (data: { files?: File[]; title?: string; text?: string; url?: string }) => Promise<void>;
}

/**
 * The "Share" door: a pill button beside NotifyButton that opens a small
 * sheet with both card formats, and hands the chosen one to the phone's
 * native share sheet (or, on a plain desktop browser, opens it in a new tab
 * with a save hint — `navigator.share` needs a real file-sharing target).
 *
 * The PNG itself is rendered server-side (app/api/share/[slug]/route.tsx)
 * from the same live conditions already on the page — this component only
 * fetches it as a Blob and hands it off.
 */
export function ShareCardSheet({ slug, beachName }: { slug: string; beachName: string }) {
  const [open, setOpen] = useState(false);
  const [format, setFormat] = useState<FormatKey>("story");
  const [loaded, setLoaded] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const cardUrl = useCallback((f: FormatKey) => `/api/share/${slug}?format=${f}`, [slug]);

  const share = useCallback(async () => {
    setErr(null);
    setBusy(true);
    try {
      const res = await fetch(cardUrl(format));
      if (!res.ok) throw new Error("Couldn't build the card — try again in a moment.");
      const blob = await res.blob();
      const file = new File([blob], `isitbeachday-${slug}-${format}.png`, { type: "image/png" });
      const title = `${beachName} — Is It Beach Day?`;
      const text = `Today's conditions at ${beachName} — Is It Beach Day?`;
      const shareUrl = `https://isitbeachday.com/${slug}?ref=share`;

      const nav = navigator as Navigator & FileShareNavigator;
      if (nav.share && nav.canShare?.({ files: [file] })) {
        await nav.share({ files: [file], title, text, url: shareUrl });
        setOpen(false);
      } else {
        // No native file-share target (most desktop browsers): the closest
        // thing to "give them the image" is opening it so they can save it.
        const blobUrl = URL.createObjectURL(blob);
        window.open(blobUrl, "_blank");
        setErr("Long-press the image to save it.");
      }
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") {
        // The person cancelled the share sheet — not an error.
      } else {
        setErr(e instanceof Error ? e.message : "Something went wrong sharing the card.");
      }
    } finally {
      setBusy(false);
    }
  }, [format, slug, beachName, cardUrl]);

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setErr(null);
          setOpen(true);
        }}
        className="inline-flex min-h-[44px] items-center gap-1.5 rounded-full bg-slate-900/5 px-3 py-1 text-xs font-medium text-slate-700 ring-1 ring-slate-900/10 transition hover:bg-slate-900/10 dark:bg-white/5 dark:text-slate-200 dark:ring-white/10 dark:hover:bg-white/10"
      >
        Share
      </button>
      <Sheet
        open={open}
        title="Share today's conditions"
        onClose={() => setOpen(false)}
        footer={
          <>
            <PrimaryButton onClick={share} disabled={busy}>
              {busy ? "Preparing…" : "Share"}
            </PrimaryButton>
            <ErrorLine message={err} />
          </>
        }
      >
        <p className="mb-4 text-sm leading-snug text-slate-600 dark:text-slate-400">
          A card with today&apos;s score, ready for your story or your feed. Pick a shape, then
          share it — post your own beach photos alongside it.
        </p>
        <div className="grid grid-cols-2 gap-3">
          {FORMATS.map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => setFormat(f.key)}
              aria-pressed={format === f.key}
              aria-label={`Use the ${f.label} format`}
              className={`flex min-h-[44px] flex-col self-start overflow-hidden rounded-2xl ring-2 transition ${
                format === f.key
                  ? "ring-ocean-500"
                  : "ring-transparent hover:ring-slate-900/10 dark:hover:ring-white/10"
              }`}
            >
              {/* The card is drawn on the server on first request (a few seconds
                  for two sizes), so the frame carries the card's own deep-blue
                  ground and says what it is doing — a white box read as broken. */}
              <span
                className="relative block w-full"
                style={{
                  aspectRatio: `${f.width} / ${f.height}`,
                  background: "linear-gradient(160deg, #041525 0%, #06263f 55%, #073a5c 100%)",
                }}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={cardUrl(f.key)}
                  alt={`${beachName} conditions card — ${f.label} preview`}
                  onLoad={() => setLoaded((l) => ({ ...l, [f.key]: true }))}
                  className={`absolute inset-0 h-full w-full transition-opacity duration-300 ${
                    loaded[f.key] ? "opacity-100" : "opacity-0"
                  }`}
                  style={{ objectFit: "cover" }}
                />
                {!loaded[f.key] ? (
                  <span className="absolute inset-0 flex items-center justify-center px-2 text-center text-xs text-slate-300">
                    Drawing your card…
                  </span>
                ) : null}
              </span>
              <span className="bg-slate-900/5 px-2 py-1.5 text-center text-xs font-medium text-slate-700 dark:bg-white/5 dark:text-slate-200">
                {f.label}
              </span>
            </button>
          ))}
        </div>
      </Sheet>
    </>
  );
}
