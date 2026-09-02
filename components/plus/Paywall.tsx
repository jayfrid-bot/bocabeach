"use client";

import { useState } from "react";
import { plusErrorMessage } from "@/lib/plus/api";
import type { PlusState } from "@/lib/plus/client";
import { ErrorLine, PrimaryButton, SecondaryButton, Sheet } from "@/components/plus/Sheet";

const APP_STORE_URL = "https://apps.apple.com/us/app/id6779072992";

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
 * There is no fake purchase here. Until billing is wired the honest paths are a
 * real 3-day trial (server-granted) and a code; anything else says so plainly.
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
    if (res.ok) setNote("Nothing to restore on this device yet.");
    else setError(plusErrorMessage(res.error));
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

      <p className="mt-4 text-center text-sm font-semibold tabular-nums text-slate-900 dark:text-white">
        $2.99/mo · $19.99/yr
      </p>

      <div className="mt-3 space-y-2">
        {trialUsed ? (
          <PrimaryButton onClick={subscribe} disabled={busy}>
            Subscribe
          </PrimaryButton>
        ) : (
          <PrimaryButton onClick={startTrial} disabled={busy}>
            {busy ? "One moment…" : "Start 3-day free trial"}
          </PrimaryButton>
        )}
        {!trialUsed ? (
          <p className="text-center text-xs leading-snug text-slate-500 dark:text-slate-400">
            Three days free. Nothing is charged today.
          </p>
        ) : null}

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
