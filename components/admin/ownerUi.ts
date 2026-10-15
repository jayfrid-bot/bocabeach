// Class strings shared by the two owner screens (QualityReview, ReportConditions).
// Big tap targets: nothing here is under 48px tall, because the owner uses these
// standing on the sand, in glare, with one thumb.

export const cardCls = "rounded-2xl bg-white/80 dark:bg-slate-900/70 p-4 ring-1 ring-slate-900/10 dark:ring-white/10";
export const bigBtn =
  "inline-flex min-h-[56px] w-full items-center justify-center rounded-2xl px-4 text-lg font-semibold transition active:scale-[0.98] disabled:opacity-50";
export const rightBtn = `${bigBtn} bg-emerald-600 text-white hover:bg-emerald-500`;
export const wrongBtn = `${bigBtn} bg-rose-600 text-white hover:bg-rose-500`;
export const chipBtn =
  "inline-flex min-h-[52px] items-center justify-center rounded-xl px-3 text-base font-medium ring-1 transition active:scale-[0.98] disabled:opacity-50";
export const chipOff =
  "bg-slate-900/5 text-slate-800 ring-slate-900/10 hover:bg-slate-900/10 dark:bg-white/5 dark:text-slate-100 dark:ring-white/10 dark:hover:bg-white/10";
export const chipOn = "bg-ocean-600 text-white ring-ocean-600";
export const linkCls =
  "inline-flex min-h-[44px] items-center text-ocean-700 underline-offset-2 hover:underline dark:text-ocean-300";
export const inputCls =
  "min-h-[52px] w-full rounded-xl bg-white px-3 text-lg text-slate-900 ring-1 ring-slate-900/15 dark:bg-slate-900 dark:text-white dark:ring-white/15";
