"use client";

import { useEffect, useState } from "react";
import { plusErrorMessage } from "@/lib/plus/api";
import {
  billingAvailable,
  loadOffers,
  purchasePlan,
  type PlanChoice,
  type PlanOffer,
} from "@/lib/plus/billing";
import type { PlusState } from "@/lib/plus/client";
import { ErrorLine, PrimaryButton, SecondaryButton, Sheet } from "@/components/plus/Sheet";

const APP_STORE_URL = "https://apps.apple.com/us/app/id6779072992";
const TERMS_URL = "https://www.apple.com/legal/internet-services/itunes/dev/stdeula/";
const PRIVACY_URL = "/privacy";

/** What the store charges when it has not told us yet (it always agrees). */
const FALLBACK_PRICE: Record<PlanChoice, string> = { monthly: "$2.99", yearly: "$19.99" };
const PER: Record<PlanChoice, string> = { monthly: "mo", yearly: "yr" };

const BENEFITS: { icon: string; title: string; body: string }[] = [
  {
    icon: "🎯",
    title: "Your score, not the average one",
    body: "The day is scored for what you actually come to the beach to do.",
  },
  {
    icon: "🛟",
    title: "Alerts from where you stand",
    body: "Lightning, flags, rip current and rain, measured from your spot on the sand.",
  },
  {
    icon: "⭐",
    title: "Best times re-ranked for you",
    body: "Today's window and the week ahead, sorted by your number.",
  },
];

/**
 * The paywall body. Rendered inside the onboarding sheet at the end of the
 * questions, and inside its own sheet when someone taps the locked pill later.
 *
 * With billing on (inside the app, with a RevenueCat key) the button runs the
 * App Store's own purchase sheet for the chosen plan, then has the server
 * confirm it. Without billing the honest paths remain: the server's 3-day
 * trial and a code. Nothing here ever pretends a purchase happened.
 */
export function PaywallBody({
  plus,
  native,
  onEntitled,
}: {
  plus: PlusState;
  /** Inside the app shell. Billing can only ever live here. */
  native: boolean;
  /** Called after the server confirms Plus is on. */
  onEntitled: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [codeOpen, setCodeOpen] = useState(false);
  const [code, setCode] = useState("");
  // Known from the device row, or learned the moment the server answers 409.
  const [trialUsed, setTrialUsed] = useState(plus.device?.trialUsed ?? false);

  // Store billing: decided on the phone, after mount, so the server render and
  // a browser both see the plain (no-billing) paywall.
  const [billing, setBilling] = useState(false);
  const [offers, setOffers] = useState<PlanOffer[] | null>(null);
  const [plan, setPlan] = useState<PlanChoice>("yearly");

  useEffect(() => {
    if (!native || !plus.deviceId || !billingAvailable()) return;
    let alive = true;
    setBilling(true);
    loadOffers(plus.deviceId)
      .then((o) => alive && setOffers(o))
      .catch(() => alive && setOffers([]));
    return () => {
      alive = false;
    };
  }, [native, plus.deviceId]);

  const priceOf = (p: PlanChoice) => offers?.find((o) => o.plan === p)?.price ?? FALLBACK_PRICE[p];

  const startTrial = async () => {
    setBusy(true);
    setError(null);
    setNote(null);
    const res = await plus.startTrial();
    setBusy(false);
    if (res.ok) {
      onEntitled();
      return;
    }
    if (res.error === "trial-used") setTrialUsed(true);
    setError(plusErrorMessage(res.error));
  };

  const buy = async () => {
    setError(null);
    setNote(null);
    const offer = offers?.find((o) => o.plan === plan);
    if (!offer) {
      setError(
        offers === null
          ? "Still loading prices from the App Store. One second."
          : "The App Store did not answer with prices. Try again in a moment.",
      );
      return;
    }
    setBusy(true);
    const outcome = await purchasePlan(plus.deviceId, offer);
    if (outcome === "purchased") {
      const res = await plus.syncPurchase();
      setBusy(false);
      if (res.ok && res.device?.plan === "plus") {
        onEntitled();
        return;
      }
      setError(plusErrorMessage("purchase-unconfirmed"));
      return;
    }
    setBusy(false);
    if (outcome === "failed") setError(plusErrorMessage("purchase-failed"));
    // "cancelled": they closed the store sheet. Nothing to say.
  };

  const subscribe = () => {
    setError(null);
    setNote(
      native
        ? "We are still connecting billing. If you have a code, use it below — otherwise check back in a few days."
        : "Subscriptions live in the app. Get Is It Beach Day on your phone to subscribe.",
    );
  };

  const redeem = async () => {
    if (!code.trim()) {
      setError("Enter your code first.");
      return;
    }
    setBusy(true);
    setError(null);
    setNote(null);
    const res = await plus.unlock(code);
    setBusy(false);
    if (res.ok) {
      onEntitled();
      return;
    }
    setError(plusErrorMessage(res.error));
  };

  const restore = async () => {
    setBusy(true);
    setError(null);
    setNote(null);
    const res = await plus.restore();
    setBusy(false);
    if (res.ok && res.device && res.device.plan === "plus") {
      onEntitled();
      return;
    }
    if (res.ok || res.error === "not-found") setNote("Nothing to restore on this device yet.");
    else setError(plusErrorMessage(res.error));
  };

  const planButton = (p: PlanChoice, label: string, tag?: string) => {
    const on = plan === p;
    return (
      <button
        type="button"
        aria-pressed={on}
        onClick={() => setPlan(p)}
        disabled={busy}
        className={`flex min-h-[56px] flex-1 flex-col items-center justify-center rounded-2xl px-3 py-2 text-center ring-2 transition ${
          on
            ? "bg-ocean-50 ring-ocean-600 dark:bg-ocean-900/40 dark:ring-ocean-400"
            : "bg-white ring-slate-900/10 dark:bg-slate-800 dark:ring-white/10"
        }`}
      >
        <span className="text-sm font-semibold text-slate-900 dark:text-white">{label}</span>
        <span className="text-sm tabular-nums text-slate-700 dark:text-slate-300">
          {priceOf(p)}/{PER[p]}
        </span>
        {tag ? (
          <span className="mt-0.5 text-[11px] font-medium text-ocean-700 dark:text-ocean-300">{tag}</span>
        ) : null}
      </button>
    );
  };

  return (
    <div>
      <p className="text-sm leading-relaxed text-slate-600 dark:text-slate-300">
        Everything you have today stays free. Plus adds the two things the beach
        does not tell you: your number, and what is happening where you are.
      </p>

      <ul className="mt-4 space-y-3">
        {BENEFITS.map((b) => (
          <li key={b.title} className="flex items-start gap-3">
            <span aria-hidden className="mt-0.5 shrink-0 text-lg leading-none">
              {b.icon}
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-semibold text-slate-900 dark:text-white">
                {b.title}
              </span>
              <span className="block text-sm leading-snug text-slate-600 dark:text-slate-400">
                {b.body}
              </span>
            </span>
          </li>
        ))}
      </ul>

      {billing ? (
        <div role="group" aria-label="Choose a plan" className="mt-4 flex gap-2">
          {planButton("yearly", "Yearly", "Best value")}
          {planButton("monthly", "Monthly")}
        </div>
      ) : (
        <p className="mt-4 text-center text-sm font-semibold tabular-nums text-slate-900 dark:text-white">
          $2.99/mo · $19.99/yr
        </p>
      )}

      <div className="mt-3 space-y-2">
        {billing ? (
          <>
            <PrimaryButton onClick={buy} disabled={busy}>
              {busy ? "One moment…" : "Start 3-day free trial"}
            </PrimaryButton>
            <p className="text-center text-xs leading-snug text-slate-500 dark:text-slate-400">
              3 days free, then {priceOf(plan)}/{PER[plan]}. Renews until you cancel in Settings.
            </p>
          </>
        ) : trialUsed ? (
          <PrimaryButton onClick={subscribe} disabled={busy}>
            Subscribe
          </PrimaryButton>
        ) : (
          <>
            <PrimaryButton onClick={startTrial} disabled={busy}>
              {busy ? "One moment…" : "Start 3-day free trial"}
            </PrimaryButton>
            <p className="text-center text-xs leading-snug text-slate-500 dark:text-slate-400">
              Three days free. Nothing is charged today.
            </p>
          </>
        )}

        {codeOpen ? (
          <div className="rounded-2xl bg-slate-900/5 p-3 dark:bg-white/5">
            <label
              htmlFor="plus-code"
              className="block text-xs font-medium text-slate-600 dark:text-slate-300"
            >
              Your code
            </label>
            <input
              id="plus-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              className="mt-1 block min-h-[44px] w-full rounded-xl border-0 bg-white px-3 py-2 text-base text-slate-900 ring-1 ring-slate-900/10 dark:bg-slate-800 dark:text-white dark:ring-white/10"
            />
            <div className="mt-2">
              <PrimaryButton onClick={redeem} disabled={busy}>
                {busy ? "Checking…" : "Unlock Plus"}
              </PrimaryButton>
            </div>
          </div>
        ) : (
          <SecondaryButton onClick={() => setCodeOpen(true)} disabled={busy}>
            Have a code?
          </SecondaryButton>
        )}

        <SecondaryButton onClick={restore} disabled={busy}>
          Restore
        </SecondaryButton>

        {billing ? (
          <div className="flex items-center justify-center gap-1 text-xs text-slate-500 dark:text-slate-400">
            <a
              href={TERMS_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex min-h-[44px] items-center px-2 underline"
            >
              Terms of Use
            </a>
            <span aria-hidden>·</span>
            <a
              href={PRIVACY_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex min-h-[44px] items-center px-2 underline"
            >
              Privacy Policy
            </a>
          </div>
        ) : null}

        {!native ? (
          <p className="text-center text-xs leading-snug text-slate-500 dark:text-slate-400">
            Alerts need the app.{" "}
            <a
              href={APP_STORE_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="text-ocean-700 underline dark:text-ocean-300"
            >
              Get it for iPhone
            </a>
            .
          </p>
        ) : null}
      </div>

      {note ? (
        <p className="mt-2 text-sm leading-snug text-slate-600 dark:text-slate-300">{note}</p>
      ) : null}
      <ErrorLine message={error} />
    </div>
  );
}

/** The paywall on its own — what the locked "Your score" pill opens. */
export function Paywall({
  open,
  onClose,
  plus,
  native,
}: {
  open: boolean;
  onClose: () => void;
  plus: PlusState;
  native: boolean;
}) {
  return (
    <Sheet open={open} title="Beach Day Plus" onClose={onClose}>
      <PaywallBody plus={plus} native={native} onEntitled={onClose} />
    </Sheet>
  );
}
