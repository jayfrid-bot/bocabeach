"use client";

/**
 * The door to Plus on the WEBSITE. Plus lives only in the phone app — billing,
 * location and push all do — so the site never runs the questions, the reveal
 * or the paywall. It says what Plus is, what it costs, and where to get it.
 * Everything the free dashboard shows stays exactly as it is above this card.
 */
const APP_STORE_URL = "https://apps.apple.com/us/app/id6779072992";

const INCLUDED = [
  "Your own Beach Day score, tuned to how you use the beach — swimming, kids, sun, snorkeling, dog walks, surf.",
  "Safety alerts computed from right where you're standing: lightning, rain, flags, rip current.",
  "Best beach times and the 7-day outlook re-ranked for you.",
  "A morning summary in your own number.",
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
            Personalize your score in the app
          </h3>
          <p className="mt-0.5 text-sm text-slate-600 dark:text-slate-300">
            Beach Day Plus lives in the iPhone app. Everything on this page stays free.
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

      <p className="mt-3 text-center text-sm font-semibold tabular-nums text-slate-900 dark:text-white">
        $2.99/mo · $19.99/yr · 3-day free trial
      </p>

      <a
        href={APP_STORE_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-3 flex min-h-[44px] w-full items-center justify-center rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-slate-800 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-100"
      >
        Get Is It Beach Day for iPhone
      </a>
      <p className="mt-2 text-center text-xs text-slate-500 dark:text-slate-400">
        Android is coming.
      </p>
    </section>
  );
}
