"use client";

import { useEffect, useState } from "react";
import { plusErrorMessage } from "@/lib/plus/api";
import {
  billingAvailable,
  loadOffers,
  purchasePlan,
  trialEligibility,
  type Eligibility,
  type PlanChoice,
  type PlanOffer,
} from "@/lib/plus/billing";
import type { PlusState } from "@/lib/plus/client";
import { deviceEntitled } from "@/lib/plus/entitlement";
import { defaultPlan, paywallCopy, PER, type OffersStatus } from "@/lib/plus/paywallCopy";
import { ErrorLine, PrimaryButton, SecondaryButton, Sheet } from "@/components/plus/Sheet";

const APP_STORE_URL = "https://apps.apple.com/us/app/id6779072992";
const TERMS_URL = "https://www.apple.com/legal/internet-services/itunes/dev/stdeula/";
const PRIVACY_URL = "/privacy";

const NO_ELIGIBILITY: Record<PlanChoice, Eligibility> = { monthly: "unknown", yearly: "unknown" };

/**
 * Ask the store for prices, then (only once there is something to ask about)
 * whether this Apple account still owes each plan a trial. Both legs are
 * never-throw contracts (see lib/plus/billing.ts), so this never rejects
 * either — a caller just awaits the plain result.
 */
async function fetchPlanData(deviceId: string): Promise<{
  offers: PlanOffer[];
  status: OffersStatus;
  plan: PlanChoice | null;
  eligibility: Record<PlanChoice, Eligibility>;
}> {
  const offers = await loadOffers(deviceId);
  const status: OffersStatus = offers.length > 0 ? "loaded" : "failed";
  const plan = defaultPlan(offers.map((o) => o.plan));
  const eligibility = offers.length > 0 ? await trialEligibility(deviceId, offers) : NO_ELIGIBILITY;
  return { offers, status, plan, eligibility };
}

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
  const [offers, setOffers] = useState<PlanOffer[]>([]);
  const [offersStatus, setOffersStatus] = useState<OffersStatus>("loading");
  const [plan, setPlan] = useState<PlanChoice | null>(null);
  const [eligibility, setEligibility] = useState<Record<PlanChoice, Eligibility>>(NO_ELIGIBILITY);

  useEffect(() => {
    if (!native || !plus.deviceId || !billingAvailable()) return;
    let alive = true;
    setBilling(true);
    setOffersStatus("loading");
    fetchPlanData(plus.deviceId).then((r) => {
      if (!alive) return;
      setOffers(r.offers);
      setOffersStatus(r.status);
      setPlan(r.plan);
      setEligibility(r.eligibility);
    });
    return () => {
      alive = false;
    };
  }, [native, plus.deviceId]);

  const priceOf = (p: PlanChoice) => offers.find((o) => o.plan === p)?.price;

  const cta = paywallCopy({
    status: offersStatus,
    plan,
    price: plan ? priceOf(plan) : undefined,
    eligibility: plan ? eligibility[plan] : "unknown",
  });

  const startTrial = async () => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const res = await plus.startTrial();
      if (res.ok) {
        onEntitled();
        return;
      }
      if (res.error === "trial-used") setTrialUsed(true);
      setError(plusErrorMessage(res.error));
    } finally {
      setBusy(false);
    }
  };

  const buy = async () => {
    const offer = offers.find((o) => o.plan === plan);
    if (!offer) return; // the CTA reads "Try again" instead of reaching here
    setError(null);
    setNote(null);
    setBusy(true);
    try {
      const outcome = await purchasePlan(plus.deviceId, offer);
      if (outcome === "purchased") {
        const res = await plus.syncPurchase();
        // Entitled NOW, not merely "plan is plus" — a synced row can still be
        // expired the instant it lands (issue #12's predicate, applied here too).
        if (res.ok && deviceEntitled(res.device, Date.now())) {
          onEntitled();
          return;
        }
        setError(plusErrorMessage("purchase-unconfirmed"));
        return;
      }
      if (outcome === "failed") setError(plusErrorMessage("purchase-failed"));
      // "cancelled": they closed the store sheet. Nothing to say.
    } finally {
      setBusy(false);
    }
  };

  /** The CTA while offers have not loaded reads "Loading prices…" and is
   *  disabled; once they fail it reads "Try again" and this reloads them. */
  const retryOffers = async () => {
    if (!plus.deviceId) return;
    setOffersStatus("loading");
    const r = await fetchPlanData(plus.deviceId);
    setOffers(r.offers);
    setOffersStatus(r.status);
    setPlan(r.plan);
    setEligibility(r.eligibility);
  };

  const handleCta = () => {
    if (offersStatus === "failed") {
      void retryOffers();
      return;
    }
    void buy();
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
    try {
      const res = await plus.unlock(code);
      if (res.ok) {
        onEntitled();
        return;
      }
      setError(plusErrorMessage(res.error));
    } finally {
      setBusy(false);
    }
  };

  const restore = async () => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const res = await plus.restore();
      // Entitled NOW, not merely "plan is plus" (issue #12): an expired trial
      // or code row must not read back as a successful restore.
      if (res.ok && deviceEntitled(res.device, Date.now())) {
        onEntitled();
        return;
      }
      if (res.ok || res.error === "not-found") setNote("Nothing to restore on this device yet.");
      else setError(plusErrorMessage(res.error));
    } finally {
      setBusy(false);
    }
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
        offers.length > 0 ? (
          // Only the plans the store actually returned — a store that only
          // has monthly must never leave yearly sitting there, selected and
          // unbuyable (issue #17, "unavailable/partial offerings").
          <div role="group" aria-label="Choose a plan" className="mt-4 flex gap-2">
            {offers.some((o) => o.plan === "yearly") ? planButton("yearly", "Yearly", "Best value") : null}
            {offers.some((o) => o.plan === "monthly") ? planButton("monthly", "Monthly") : null}
          </div>
        ) : (
          <p className="mt-4 text-center text-sm text-slate-500 dark:text-slate-400">
            {offersStatus === "loading"
              ? "Loading prices…"
              : "We could not load prices from the App Store."}
          </p>
        )
      ) : (
        <p className="mt-4 text-center text-sm font-semibold tabular-nums text-slate-900 dark:text-white">
          $2.99/mo · $19.99/yr
        </p>
      )}

      <div className="mt-3 space-y-2">
        {billing ? (
          <>
            <PrimaryButton onClick={handleCta} disabled={busy || cta.ctaDisabled}>
              {busy ? "One moment…" : cta.ctaLabel}
            </PrimaryButton>
            {cta.finePrint ? (
              <p className="text-center text-xs leading-snug text-slate-500 dark:text-slate-400">
                {cta.finePrint}
              </p>
            ) : null}
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
