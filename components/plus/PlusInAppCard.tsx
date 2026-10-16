"use client";

/**
 * The door to the APP on the WEBSITE. The goal is a download, so this card
 * sells the free app — 20 data points in one score, plus alerts — and shows no
 * price: the price and the free trial live in the app, one tap from the
 * paywall (Apple requires the app to show them before any purchase). One small
 * line says some features need Plus, so nobody downloads expecting free alerts
 * and meets a paywall. Five lines at most, each a plain benefit. Everything the
 * free dashboard shows stays exactly as it is above this card.
 */
import { GET_APP_PATH } from "@/lib/appStore";
import { inAppSunLine } from "@/lib/plus/sunAlertCopy";

const INCLUDED = [
  "Lightning and rain alerts where you're standing",
  inAppSunLine(),
  "A beach score tuned to how you use the beach",
  "Your live beach score on the Lock Screen",
  "Look back at any past day at your beach",
];

export function PlusInAppCard() {
  return (
    <section
      aria-labelledby="plus-in-app-title"
      className="mx-auto w-full max-w-md rounded-2xl bg-white/80 p-4 ring-1 ring-slate-900/10 dark:bg-slate-900/70 dark:ring-white/10"
    >
      <div className="flex items-start gap-3">
        <span aria-hidden className="shrink-0 text-xl leading-none">
          🎯
        </span>
        <div className="min-w-0 flex-1">
          <h3
            id="plus-in-app-title"
            className="text-base font-semibold text-slate-900 dark:text-white"
          >
            Get the free app
          </h3>
          <p className="mt-0.5 text-sm text-slate-600 dark:text-slate-300">
            20 data points in one simple beach score, plus alerts in your pocket.
          </p>
        </div>
      </div>

      <ul className="mt-3 space-y-1.5 text-sm text-slate-700 dark:text-slate-200">
        {INCLUDED.map((line) => (
          <li key={line} className="flex gap-2">
            <span aria-hidden className="mt-[3px] shrink-0 text-ocean-600 dark:text-ocean-300">
              ✓
            </span>
            <span>{line}</span>
          </li>
        ))}
      </ul>

      <a
        href={GET_APP_PATH}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-3 flex min-h-[44px] w-full items-center justify-center rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-slate-800 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-100"
      >
        Download free on the App Store
      </a>
      <p className="mt-2 text-center text-xs text-slate-500 dark:text-slate-400">
        Some features need Beach Day Plus. Try it free in the app. Android is coming.
      </p>
    </section>
  );
}
