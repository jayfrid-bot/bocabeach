"use client";

// Owner-only review screen (docs/QUALITY_PLAN.md, "Confirm"). A public shell:
// every alert, picture and number arrives through /api/quality/owner/list,
// which only the owner's device passes (lib/quality/owner.ts). A phone that is
// not on the list sees a closed door and its own device id, which it can add to
// the OWNER_DEVICE_IDS secret.
//
// Each open alert is one card: the picture, one sentence to judge, what the app
// showed, and two big buttons. "Wrong" opens a one-tap picker for the correct
// value; the tap sends the answer.

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ThemeToggle } from "@/components/ThemeToggle";
import { getDeviceId } from "@/lib/deviceId";
import { ownerErrorText, ownerPost, writeOwnerHint } from "@/lib/quality/client";
import type { AlertView } from "@/lib/quality/review";
import { CLARITY_WORDS, SEAWEED_LEVELS } from "@/lib/quality/types";
import { bigBtn, cardCls, chipBtn, chipOff, inputCls, linkCls, rightBtn, wrongBtn } from "@/components/admin/ownerUi";

interface ListReply {
  ok: true;
  open: AlertView[];
  recent: AlertView[];
}

type Phase =
  | { kind: "loading" }
  | { kind: "closed"; error: string }
  | { kind: "ready"; open: AlertView[]; recent: AlertView[] };

const CLARITY_LABEL: Record<string, string> = { clear: "Clear", slightly_murky: "Slightly murky", murky: "Murky" };

function clock(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function describeAnswer(a: AlertView): string {
  if (a.status === "expired") return "Expired";
  if (!a.answer) return "Open";
  if (a.answer.verdict === "right") return "Right";
  const c = a.answer.correct as { level?: string; word?: string; value?: number } | null;
  const truth = c?.level ?? (c?.word ? CLARITY_LABEL[c.word] : undefined) ?? (typeof c?.value === "number" ? `${c.value}${a.unit ? ` ${a.unit}` : ""}` : null);
  return truth ? `Wrong, really ${truth}` : "Wrong";
}

function AlertCard({ alert, focused, onDone }: { alert: AlertView; focused: boolean; onDone: (id: number) => void }) {
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [num, setNum] = useState("");
  const ref = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ block: "start" });
  }, [focused]);

  const send = useCallback(
    async (verdict: "right" | "wrong", correct?: Record<string, unknown>) => {
      setBusy(true);
      setError(null);
      const r = await ownerPost<{ ok: true }>("/api/quality/owner/answer", { alertId: alert.id, verdict, correct });
      setBusy(false);
      if (r.ok) onDone(alert.id);
      else setError(ownerErrorText(r.error));
    },
    [alert.id, onDone],
  );

  return (
    <article ref={ref} className={`${cardCls} ${focused ? "ring-2 ring-ocean-500" : ""}`} aria-label={`${alert.beach} ${alert.signalWord}`}>
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-medium text-slate-700 dark:text-slate-300">
          {alert.beach} · {alert.signalWord}
        </h2>
        <span className="shrink-0 text-xs text-slate-500 dark:text-slate-400">{clock(alert.createdAt)}</span>
      </div>

      {alert.frames.map((f) => (
        <figure key={`${f.camId}-${f.takenAt}`} className="mt-3">
          {f.url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={f.url} alt={`${f.camId} cam frame`} loading="lazy" className="w-full rounded-xl bg-slate-200 dark:bg-slate-800" />
          ) : (
            <div className="rounded-xl bg-slate-100 p-4 text-sm text-slate-500 dark:bg-slate-800">Picture link unavailable.</div>
          )}
          <figcaption className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            {f.camId} · {clock(f.takenAt)} · {f.exact ? "the exact frame" : "nearest saved frame"}
            {f.credit ? ` · ${f.credit}` : ""}
          </figcaption>
        </figure>
      ))}
      {alert.frames.length === 0 ? (
        <p className="mt-3 rounded-xl bg-slate-100 p-3 text-sm text-slate-500 dark:bg-slate-800 dark:text-slate-400">No saved picture for this one.</p>
      ) : null}

      <p className="mt-3 text-lg font-semibold leading-snug text-slate-900 dark:text-white">{alert.statement}</p>
      {alert.published ? <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">{alert.published}</p> : null}
      {alert.secondOpinion ? <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">{alert.secondOpinion}</p> : null}
      {alert.others.length ? (
        <ul className="mt-2 flex flex-wrap gap-1.5" aria-label="Other cams">
          {alert.others.map((o) => (
            <li key={o.name} className="rounded-full bg-slate-900/5 px-2.5 py-1 text-xs text-slate-700 dark:bg-white/10 dark:text-slate-200">
              {o.name}: {o.level}
            </li>
          ))}
        </ul>
      ) : null}

      <p className="mt-4 text-sm font-medium text-slate-700 dark:text-slate-300">Is this right?</p>
      {!picking ? (
        <div className="mt-2 grid grid-cols-2 gap-3">
          <button type="button" className={rightBtn} disabled={busy} onClick={() => void send("right")}>
            Right
          </button>
          <button type="button" className={wrongBtn} disabled={busy} onClick={() => setPicking(true)}>
            Wrong
          </button>
        </div>
      ) : (
        <div className="mt-2">
          <p className="mb-2 text-sm text-slate-700 dark:text-slate-300">What is it really?</p>
          {alert.input === "seaweed" ? (
            <div className="grid grid-cols-2 gap-2">
              {SEAWEED_LEVELS.map((l) => (
                <button key={l} type="button" className={`${chipBtn} ${chipOff} capitalize`} disabled={busy} onClick={() => void send("wrong", { level: l })}>
                  {l}
                </button>
              ))}
            </div>
          ) : null}
          {alert.input === "clarity" ? (
            <div className="grid grid-cols-3 gap-2">
              {CLARITY_WORDS.map((w) => (
                <button key={w} type="button" className={`${chipBtn} ${chipOff}`} disabled={busy} onClick={() => void send("wrong", { word: w })}>
                  {CLARITY_LABEL[w]}
                </button>
              ))}
            </div>
          ) : null}
          {alert.input === "number" ? (
            <div className="flex gap-2">
              <input
                className={inputCls}
                inputMode="decimal"
                placeholder={alert.unit ? `Number (${alert.unit})` : "Number"}
                value={num}
                onChange={(e) => setNum(e.target.value)}
                aria-label="Correct value"
              />
              <button
                type="button"
                className={`${chipBtn} ${chipOff} shrink-0 px-5`}
                disabled={busy || !Number.isFinite(Number(num)) || num.trim() === ""}
                onClick={() => void send("wrong", { value: Number(num) })}
              >
                Save
              </button>
            </div>
          ) : null}
          <div className="mt-1 flex items-center gap-4">
            {alert.input === "number" ? (
              <button type="button" className={linkCls} disabled={busy} onClick={() => void send("wrong")}>
                Not sure what it is
              </button>
            ) : null}
            <button type="button" className={linkCls} disabled={busy} onClick={() => setPicking(false)}>
              Back
            </button>
          </div>
        </div>
      )}
      {error ? <p role="alert" className="mt-2 text-sm text-rose-600 dark:text-rose-400">{error}</p> : null}
    </article>
  );
}

export function QualityReview({ focusAlertId }: { focusAlertId: number | null }) {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [deviceId, setDeviceId] = useState("");

  const load = useCallback(async () => {
    const r = await ownerPost<ListReply>("/api/quality/owner/list");
    if (r.ok) {
      writeOwnerHint(true);
      setPhase({ kind: "ready", open: r.data.open, recent: r.data.recent });
    } else {
      if (r.error === "not-owner") writeOwnerHint(false);
      setPhase({ kind: "closed", error: r.error });
    }
  }, []);

  useEffect(() => {
    setDeviceId(getDeviceId());
    void load();
  }, [load]);

  const answered = useCallback(() => void load(), [load]);

  return (
    <main className="mx-auto max-w-xl px-4 py-6 sm:px-6">
      <header className="mb-4 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Quality review</h1>
          <p className="text-sm text-slate-600 dark:text-slate-400">Numbers the app was not sure about.</p>
        </div>
        <ThemeToggle />
      </header>

      {phase.kind === "loading" ? <p className="text-slate-600 dark:text-slate-400">Loading.</p> : null}

      {phase.kind === "closed" ? (
        <section className={cardCls}>
          <p className="text-slate-800 dark:text-slate-100">{ownerErrorText(phase.error)}</p>
          {phase.error === "not-owner" || phase.error === "owner-not-configured" ? (
            <details className="mt-3 text-sm text-slate-600 dark:text-slate-400">
              <summary className="cursor-pointer">This phone&apos;s device id</summary>
              <p className="mt-2 break-all font-mono text-xs">{deviceId || "none"}</p>
              <p className="mt-2">To make this phone the owner, add that id to the OWNER_DEVICE_IDS secret.</p>
            </details>
          ) : null}
          <button type="button" className={`${bigBtn} mt-4 bg-slate-900/5 text-slate-800 dark:bg-white/10 dark:text-white`} onClick={() => void load()}>
            Try again
          </button>
        </section>
      ) : null}

      {phase.kind === "ready" ? (
        <>
          <nav className="mb-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
            <Link href="/admin/report" className={linkCls}>
              Report conditions
            </Link>
            <button type="button" className={linkCls} onClick={() => void load()}>
              Refresh
            </button>
          </nav>

          {phase.open.length === 0 ? (
            <section className={cardCls}>
              <p className="text-slate-800 dark:text-slate-100">Nothing to check right now.</p>
            </section>
          ) : (
            <div className="space-y-4">
              {phase.open.map((a) => (
                <AlertCard key={a.id} alert={a} focused={a.id === focusAlertId} onDone={answered} />
              ))}
            </div>
          )}

          {phase.recent.length ? (
            <section className="mt-8">
              <h2 className="mb-2 text-sm font-medium text-slate-700 dark:text-slate-300">Recent</h2>
              <ul className="space-y-2">
                {phase.recent.map((a) => (
                  <li key={a.id} className={`${cardCls} py-3`}>
                    <div className="flex items-baseline justify-between gap-3 text-xs text-slate-500 dark:text-slate-400">
                      <span>
                        {a.beach} · {a.signalWord}
                      </span>
                      <span className="shrink-0">{describeAnswer(a)}</span>
                    </div>
                    <p className="mt-1 text-sm text-slate-800 dark:text-slate-100">{a.statement}</p>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </>
      ) : null}
    </main>
  );
}
