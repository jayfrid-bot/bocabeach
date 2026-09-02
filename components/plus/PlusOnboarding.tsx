"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { PROFILE_IDS, profileChip } from "@/lib/profile/presets";
import { profileLabel, resolveScoring } from "@/lib/profile/resolve";
import type { CrowdSensitivity, HeatPreference, ProfileId, ScoreProfile } from "@/lib/profile/types";
import { computePersonalScore } from "@/lib/plus/personalScore";
import { buildPreview } from "@/lib/plus/preview";
import type { PlusState } from "@/lib/plus/client";
import type { ConditionsResponse } from "@/lib/types";
import { Chip, PrimaryButton, Sheet } from "@/components/plus/Sheet";
import { PaywallBody } from "@/components/plus/Paywall";

const HEAT_CHOICES: { value: HeatPreference; label: string }[] = [
  { value: "cooler", label: "Cooler" },
  { value: "normal", label: "Just right" },
  { value: "hot", label: "Hot" },
];

const CROWD_CHOICES: { value: CrowdSensitivity; label: string }[] = [
  { value: "low", label: "Not really" },
  { value: "normal", label: "Somewhat" },
  { value: "high", label: "A lot" },
];

type Step = "questions" | "reveal" | "paywall";

/**
 * The one time we ask. Three questions, then the single reveal of the personal
 * number, then the paywall. It runs once per phone: after the reveal the answers
 * and `previewSeen` are saved on the phone AND on the device row, so a decline
 * never sends anyone back through these questions.
 */
export function PlusOnboarding({
  open,
  onClose,
  plus,
  res,
  nowMs,
  native,
}: {
  open: boolean;
  onClose: () => void;
  plus: PlusState;
  res: ConditionsResponse;
  nowMs: number;
  native: boolean;
}) {
  const saved = plus.profile;
  const [profiles, setProfiles] = useState<ProfileId[]>(saved?.profiles ?? []);
  const [heat, setHeat] = useState<HeatPreference>(saved?.heat ?? "normal");
  const [crowds, setCrowds] = useState<CrowdSensitivity>(saved?.crowds ?? "normal");
  const [step, setStep] = useState<Step>("questions");
  const openedRef = useRef(false);

  // Re-open with whatever is saved, and always start at the first question.
  // ONLY on the transition into open: the reveal screen saves the profile, and
  // re-running this on that change would bounce the sheet back to question one.
  useEffect(() => {
    if (!open) {
      openedRef.current = false;
      return;
    }
    if (openedRef.current) return;
    openedRef.current = true;
    setProfiles(plus.profile?.profiles ?? []);
    setHeat(plus.profile?.heat ?? "normal");
    setCrowds(plus.profile?.crowds ?? "normal");
    setStep("questions");
  }, [open, plus.profile]);

  const draft: ScoreProfile = useMemo(
    () => ({ profiles, heat, crowds, ...(saved?.advanced ? { advanced: saved.advanced } : {}) }),
    [profiles, heat, crowds, saved?.advanced],
  );

  const toggleProfile = (id: ProfileId) => {
    setProfiles((prev) => {
      if (prev.includes(id)) return prev.filter((p) => p !== id);
      if (prev.length >= 2) return [prev[1], id]; // two at most; oldest drops out
      return [...prev, id];
    });
  };

  const title =
    step === "questions" ? "Personalize my score" : step === "reveal" ? "Your score" : "Beach Day Plus";

  return (
    <Sheet open={open} title={title} onClose={onClose}>
      {step === "questions" ? (
        <Questions
          profiles={profiles}
          heat={heat}
          crowds={crowds}
          onToggleProfile={toggleProfile}
          onHeat={setHeat}
          onCrowds={setCrowds}
          onDone={() => setStep("reveal")}
        />
      ) : null}

      {step === "reveal" ? (
        <RevealScreen
          plus={plus}
          profile={draft}
          res={res}
          nowMs={nowMs}
          onDone={() => setStep("paywall")}
        />
      ) : null}

      {step === "paywall" ? (
        <PaywallBody plus={plus} native={native} onEntitled={onClose} />
      ) : null}
    </Sheet>
  );
}

function Questions({
  profiles,
  heat,
  crowds,
  onToggleProfile,
  onHeat,
  onCrowds,
  onDone,
}: {
  profiles: ProfileId[];
  heat: HeatPreference;
  crowds: CrowdSensitivity;
  onToggleProfile: (id: ProfileId) => void;
  onHeat: (h: HeatPreference) => void;
  onCrowds: (c: CrowdSensitivity) => void;
  onDone: () => void;
}) {
  return (
    <div>
      <p className="text-sm leading-relaxed text-slate-600 dark:text-slate-300">
        Three questions. Then we show you today scored your way.
      </p>

      <fieldset className="mt-4">
        <legend className="text-sm font-semibold text-slate-900 dark:text-white">
          What do you go to the beach for?
        </legend>
        <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">Pick one or two.</p>
        <div className="mt-2 flex flex-wrap gap-2">
          {PROFILE_IDS.map((id) => (
            <Chip key={id} selected={profiles.includes(id)} onClick={() => onToggleProfile(id)}>
              {profileChip(id)}
            </Chip>
          ))}
        </div>
      </fieldset>

      <fieldset className="mt-5">
        <legend className="text-sm font-semibold text-slate-900 dark:text-white">
          How do you like the weather?
        </legend>
        <div className="mt-2 flex flex-wrap gap-2">
          {HEAT_CHOICES.map((c) => (
            <Chip key={c.value} selected={heat === c.value} onClick={() => onHeat(c.value)}>
              {c.label}
            </Chip>
          ))}
        </div>
      </fieldset>

      <fieldset className="mt-5">
        <legend className="text-sm font-semibold text-slate-900 dark:text-white">
          Do crowds bother you?
        </legend>
        <div className="mt-2 flex flex-wrap gap-2">
          {CROWD_CHOICES.map((c) => (
            <Chip key={c.value} selected={crowds === c.value} onClick={() => onCrowds(c.value)}>
              {c.label}
            </Chip>
          ))}
        </div>
      </fieldset>

      <div className="mt-6">
        <PrimaryButton onClick={onDone} disabled={profiles.length === 0}>
          See my score
        </PrimaryButton>
        {profiles.length === 0 ? (
          <p className="mt-2 text-center text-xs text-slate-500 dark:text-slate-400">
            Pick at least one to carry on.
          </p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The reveal. Computed exactly once from the response already on screen — no
 * fetch, no second opinion — then saved so the locked pill can remind them of
 * this number later.
 */
function RevealScreen({
  plus,
  profile,
  res,
  nowMs,
  onDone,
}: {
  plus: PlusState;
  profile: ScoreProfile;
  res: ConditionsResponse;
  nowMs: number;
  onDone: () => void;
}) {
  const label = profileLabel(profile);
  // One computation, pinned for the life of this screen.
  const personal = useMemo(
    () => computePersonalScore(res, resolveScoring(profile), nowMs).score.score,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const everyone = res.score.score;
  const delta = personal - everyone;
  const savedRef = useRef(false);

  useEffect(() => {
    if (savedRef.current) return;
    savedRef.current = true;
    plus.savePreview(buildPreview(personal, everyone, label, nowMs, res.snapshot.location.timezone));
    void plus.commitProfile(profile, true);
    // Saved once, on first paint of this screen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div>
      <div className="rounded-2xl bg-ocean-500/10 px-4 py-5 text-center ring-1 ring-ocean-500/20">
        <div className="text-xs font-medium uppercase tracking-wide text-ocean-800 dark:text-ocean-200">
          Your score today
        </div>
        <div className="mt-1 text-5xl font-bold tabular-nums text-slate-900 dark:text-white">
          {personal}
        </div>
        <div className="mt-2 text-sm text-slate-700 dark:text-slate-300">
          Everyone&apos;s score today is{" "}
          <span className="font-semibold tabular-nums">{everyone}</span>
        </div>
        <div className="mt-1 text-sm text-slate-600 dark:text-slate-400">Tuned for {label}</div>
      </div>

      <p className="mt-4 text-sm leading-relaxed text-slate-600 dark:text-slate-300">
        {delta === 0
          ? "Today your number lands where everyone else's does. On most days it will not."
          : `That is ${Math.abs(delta)} ${Math.abs(delta) === 1 ? "point" : "points"} ${
              delta > 0 ? "above" : "below"
            } the everyone score — the same beach, weighted for you.`}
      </p>

      <div className="mt-5">
        <PrimaryButton onClick={onDone}>Keep my score</PrimaryButton>
      </div>
    </div>
  );
}
