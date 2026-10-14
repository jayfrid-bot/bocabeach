"use client";

// "Report conditions" (docs/QUALITY_PLAN.md, "Confirm"): the owner, standing on
// the beach, tells the app what is really there. Big taps for seaweed and water
// clarity, optional surf and sand, an optional note. Each answer is saved as a
// label, with the nearest saved camera frames, by /api/quality/owner/report
// (owner token only; a public shell otherwise).

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ThemeToggle } from "@/components/ThemeToggle";
import { ownerErrorText, ownerPost, writeOwnerHint } from "@/lib/quality/client";
import { CLARITY_WORDS, SEAWEED_LEVELS } from "@/lib/quality/types";
import { bigBtn, cardCls, chipBtn, chipOff, chipOn, inputCls, linkCls } from "@/components/admin/ownerUi";

export interface BeachChoice {
  slug: string;
  name: string;
}

const LAST_BEACH_KEY = "bd:report-beach";
const CLARITY_LABEL: Record<string, string> = { clear: "Clear", slightly_murky: "Slightly murky", murky: "Murky" };

function readLastBeach(): string | null {
  try {
    return localStorage.getItem(LAST_BEACH_KEY);
  } catch {
    return null;
  }
}

function Chips<T extends string>({
  label,
  options,
  value,
  onChange,
  cols,
  render,
}: {
  label: string;
  options: readonly T[];
  value: T | null;
  onChange: (v: T | null) => void;
  cols: string;
  render?: (v: T) => string;
}) {
  return (
    <fieldset className="mt-5">
      <legend className="mb-2 text-sm font-medium text-slate-700 dark:text-slate-300">{label}</legend>
      <div className={`grid gap-2 ${cols}`}>
        {options.map((o) => (
          <button
            key={o}
            type="button"
            aria-pressed={value === o}
            className={`${chipBtn} ${value === o ? chipOn : chipOff} ${render ? "" : "capitalize"}`}
            onClick={() => onChange(value === o ? null : o)}
          >
            {render ? render(o) : o}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

function Stepper({
  label,
  unit,
  value,
  onChange,
  step,
  start,
}: {
  label: string;
  unit: string;
  value: string;
  onChange: (v: string) => void;
  step: number;
  start: number;
}) {
  const bump = (dir: 1 | -1) => {
    const n = Number(value);
    const base = value.trim() !== "" && Number.isFinite(n) ? n : start - dir * step;
    onChange(String(Math.max(0, Math.round((base + dir * step) * 10) / 10)));
  };
  return (
    <div className="mt-5">
      <label className="mb-2 block text-sm font-medium text-slate-700 dark:text-slate-300">
        {label} <span className="font-normal text-slate-500">(optional)</span>
      </label>
      <div className="flex items-center gap-2">
        <button type="button" className={`${chipBtn} ${chipOff} w-14 shrink-0 text-2xl`} aria-label={`Less ${label}`} onClick={() => bump(-1)}>
          −
        </button>
        <input
          className={`${inputCls} text-center`}
          inputMode="decimal"
          placeholder={unit}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-label={`${label} in ${unit}`}
        />
        <button type="button" className={`${chipBtn} ${chipOff} w-14 shrink-0 text-2xl`} aria-label={`More ${label}`} onClick={() => bump(1)}>
          +
        </button>
      </div>
    </div>
  );
}

export function ReportConditions({ beaches, initialSlug }: { beaches: BeachChoice[]; initialSlug: string | null }) {
  const [slug, setSlug] = useState(initialSlug && beaches.some((b) => b.slug === initialSlug) ? initialSlug : (beaches[0]?.slug ?? ""));
  const [seaweed, setSeaweed] = useState<(typeof SEAWEED_LEVELS)[number] | null>(null);
  const [clarity, setClarity] = useState<(typeof CLARITY_WORDS)[number] | null>(null);
  const [surf, setSurf] = useState("");
  const [sand, setSand] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);

  // No ?slug= means "the beach I last reported on".
  useEffect(() => {
    if (initialSlug) return;
    const last = readLastBeach();
    if (last && beaches.some((b) => b.slug === last)) setSlug(last);
  }, [initialSlug, beaches]);

  const surfN = surf.trim() === "" ? undefined : Number(surf);
  const sandN = sand.trim() === "" ? undefined : Number(sand);
  const badNumber = (surfN !== undefined && !Number.isFinite(surfN)) || (sandN !== undefined && !Number.isFinite(sandN));
  const nothing = !seaweed && !clarity && surfN === undefined && sandN === undefined && !note.trim();

  const submit = useCallback(async () => {
    setBusy(true);
    setMessage(null);
    const r = await ownerPost<{ ok: true; saved: number; frames: number }>("/api/quality/owner/report", {
      slug,
      seaweed,
      clarity,
      surfFt: surfN,
      sandF: sandN,
      note: note.trim() || undefined,
    });
    setBusy(false);
    if (!r.ok) {
      setMessage({ tone: "bad", text: r.error === "bad-request" ? "One of the numbers looks off." : ownerErrorText(r.error) });
      return;
    }
    writeOwnerHint(true);
    try {
      localStorage.setItem(LAST_BEACH_KEY, slug);
    } catch {
      /* fine */
    }
    setMessage({
      tone: "ok",
      text: `Saved ${r.data.saved} ${r.data.saved === 1 ? "reading" : "readings"} with ${r.data.frames} ${r.data.frames === 1 ? "picture" : "pictures"}.`,
    });
    setSeaweed(null);
    setClarity(null);
    setSurf("");
    setSand("");
    setNote("");
  }, [slug, seaweed, clarity, surfN, sandN, note]);

  return (
    <main className="mx-auto max-w-xl px-4 py-6 sm:px-6">
      <header className="mb-4 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Report conditions</h1>
          <p className="text-sm text-slate-600 dark:text-slate-400">Tell the app what is really there.</p>
        </div>
        <ThemeToggle />
      </header>

      <section className={cardCls}>
        <label htmlFor="report-beach" className="mb-2 block text-sm font-medium text-slate-700 dark:text-slate-300">
          Beach
        </label>
        <select id="report-beach" className={inputCls} value={slug} onChange={(e) => setSlug(e.target.value)}>
          {beaches.map((b) => (
            <option key={b.slug} value={b.slug}>
              {b.name}
            </option>
          ))}
        </select>

        <Chips label="Seaweed" options={SEAWEED_LEVELS} value={seaweed} onChange={setSeaweed} cols="grid-cols-2 sm:grid-cols-4" />
        <Chips label="Water clarity" options={CLARITY_WORDS} value={clarity} onChange={setClarity} cols="grid-cols-3" render={(w) => CLARITY_LABEL[w]} />
        <Stepper label="Surf height" unit="ft" value={surf} onChange={setSurf} step={0.5} start={2} />
        <Stepper label="Sand temperature" unit="°F" value={sand} onChange={setSand} step={1} start={90} />

        <label htmlFor="report-note" className="mb-2 mt-5 block text-sm font-medium text-slate-700 dark:text-slate-300">
          Note <span className="font-normal text-slate-500">(optional)</span>
        </label>
        <textarea
          id="report-note"
          className={`${inputCls} min-h-[88px] py-2`}
          maxLength={500}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />

        <button
          type="button"
          className={`${bigBtn} mt-5 bg-ocean-600 text-white hover:bg-ocean-500`}
          disabled={busy || nothing || badNumber || !slug}
          onClick={() => void submit()}
        >
          {busy ? "Saving" : "Send report"}
        </button>
        {message ? (
          <p role="status" className={`mt-3 text-sm ${message.tone === "ok" ? "text-emerald-700 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}`}>
            {message.text}
          </p>
        ) : null}
      </section>

      <nav className="mt-4 text-sm">
        <Link href="/admin/review" className={linkCls}>
          Quality review
        </Link>
      </nav>
    </main>
  );
}
