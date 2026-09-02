"use client";

import { useEffect, useState } from "react";
import { PROFILE_IDS, profileChip } from "@/lib/profile/presets";
import { resolveScoring } from "@/lib/profile/resolve";
import type {
  CrowdSensitivity,
  FactorMultiplier,
  HeatPreference,
  ProfileId,
  ScoreProfile,
  SubKey,
  WaveMode,
} from "@/lib/profile/types";
import type { AlertKey } from "@/lib/db/types";
import { ALERT_GROUPS, ALERT_LABELS, FACTOR_LABELS, FACTOR_ORDER, MULTIPLIER_STOPS } from "@/lib/plus/labels";
import { plusErrorMessage } from "@/lib/plus/api";
import type { PlusState } from "@/lib/plus/client";
import { entitlementRemaining } from "@/lib/plus/entitlement";
import { getHomeBeach, setHomeBeach } from "@/lib/homeBeach";
import type { LocationPublic } from "@/lib/types";
import { Chip, ErrorLine, PrimaryButton, SecondaryButton, Sheet } from "@/components/plus/Sheet";

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
const WAVE_CHOICES: { value: WaveMode; label: string }[] = [
  { value: "calm", label: "Calm" },
  { value: "some", label: "Some" },
  { value: "surf", label: "Surf" },
];

const inputClass =
  "min-h-[44px] w-full rounded-xl border-0 bg-white px-3 py-2 text-base text-slate-900 ring-1 ring-slate-900/10 dark:bg-slate-800 dark:text-white dark:ring-white/10";

/**
 * Everything a subscriber can change, in one sheet: what they come to the beach
 * for, how they like it, the per-factor Advanced dials, their home beach, and
 * which alerts they want. Edits land on the phone immediately (the score behind
 * this sheet moves as you tap) and are written to the device row a moment later.
 */
export function PlusSettingsSheet({
  open,
  onClose,
  plus,
  beaches,
  native,
  personalScore,
}: {
  open: boolean;
  onClose: () => void;
  plus: PlusState;
  beaches: LocationPublic[];
  native: boolean;
  /** The live personal number, so the effect of an edit is visible in here. */
  personalScore: number | null;
}) {
  const profile: ScoreProfile = plus.profile ?? { profiles: [], heat: "normal", crowds: "normal" };
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [home, setHome] = useState<string | null>(null);
  const [codeOpen, setCodeOpen] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    if (open) setHome(getHomeBeach());
  }, [open]);

  const update = (patch: Partial<ScoreProfile>) => {
    plus.saveProfile({ ...profile, ...patch });
  };

  const toggleProfile = (id: ProfileId) => {
    const prev = profile.profiles ?? [];
    let next: ProfileId[];
    if (prev.includes(id)) next = prev.filter((p) => p !== id);
    else if (prev.length >= 2) next = [prev[1], id];
    else next = [...prev, id];
    if (!next.length) return; // never leave a subscriber with no profile at all
    update({ profiles: next });
  };

  const setAdvanced = (patch: Partial<NonNullable<ScoreProfile["advanced"]>>) => {
    update({ advanced: { ...(profile.advanced ?? {}), ...patch } });
  };

  const resetAdvanced = () => {
    const next = { ...profile };
    delete next.advanced;
    plus.saveProfile(next);
  };

  const pickHome = async (slug: string) => {
    setHome(slug);
    setHomeBeach(slug);
    setError(null);
    const res = await plus.setHome(slug);
    if (!res.ok) setError(plusErrorMessage(res.error));
  };

  const toggleAlert = async (key: AlertKey, on: boolean) => {
    setError(null);
    const res = await plus.savePrefs({ [key]: on } as Partial<Record<AlertKey, boolean>>);
    if (!res.ok) setError(plusErrorMessage(res.error));
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
      setNote("Plus is on.");
      setCodeOpen(false);
      setCode("");
    } else setError(plusErrorMessage(res.error));
  };

  const restore = async () => {
    setBusy(true);
    setError(null);
    setNote(null);
    const res = await plus.restore();
    setBusy(false);
    if (res.ok && res.device?.plan === "plus") setNote("Restored.");
    else if (res.ok) setNote("Nothing to restore on this device yet.");
    else setError(plusErrorMessage(res.error));
  };

  const opts = resolveScoring(plus.profile);
  const remaining = entitlementRemaining(plus.cache, Date.now());
  const rangeKey = `${profile.profiles.join("-")}-${profile.heat}`;

  return (
    <Sheet open={open} title="Your beach settings" onClose={onClose}>
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-sm text-slate-600 dark:text-slate-300">
          {personalScore != null ? (
            <>
              Your score right now:{" "}
              <span className="font-bold tabular-nums text-slate-900 dark:text-white">
                {personalScore}
              </span>
            </>
          ) : (
            "Pick what you come here for and the score follows."
          )}
        </p>
        {remaining ? (
          <span className="shrink-0 text-xs text-slate-500 dark:text-slate-400">{remaining}</span>
        ) : null}
      </div>

      <fieldset className="mt-4">
        <legend className="text-sm font-semibold text-slate-900 dark:text-white">
          What you come here for
        </legend>
        <div className="mt-2 flex flex-wrap gap-2">
          {PROFILE_IDS.map((id) => (
            <Chip
              key={id}
              selected={profile.profiles.includes(id)}
              onClick={() => toggleProfile(id)}
            >
              {profileChip(id)}
            </Chip>
          ))}
        </div>
      </fieldset>

      <fieldset className="mt-5">
        <legend className="text-sm font-semibold text-slate-900 dark:text-white">
          How you like the weather
        </legend>
        <div className="mt-2 flex flex-wrap gap-2">
          {HEAT_CHOICES.map((c) => (
            <Chip key={c.value} selected={profile.heat === c.value} onClick={() => update({ heat: c.value })}>
              {c.label}
            </Chip>
          ))}
        </div>
      </fieldset>

      <fieldset className="mt-5">
        <legend className="text-sm font-semibold text-slate-900 dark:text-white">
          Do crowds bother you
        </legend>
        <div className="mt-2 flex flex-wrap gap-2">
          {CROWD_CHOICES.map((c) => (
            <Chip
              key={c.value}
              selected={profile.crowds === c.value}
              onClick={() => update({ crowds: c.value })}
            >
              {c.label}
            </Chip>
          ))}
        </div>
      </fieldset>

      {/* --- Advanced ------------------------------------------------------ */}
      <div className="mt-5 border-t border-slate-900/10 pt-4 dark:border-white/10">
        <button
          type="button"
          onClick={() => setAdvancedOpen((v) => !v)}
          aria-expanded={advancedOpen}
          className="flex min-h-[44px] w-full items-center justify-between gap-2 text-left text-sm font-semibold text-slate-900 dark:text-white"
        >
          Advanced
          <span aria-hidden className="text-slate-400">
            {advancedOpen ? "▾" : "▸"}
          </span>
        </button>

        {advancedOpen ? (
          <div className="mt-2">
            <p className="text-xs leading-snug text-slate-500 dark:text-slate-400">
              How much each thing counts, on top of what your picks already do.
            </p>
            <div className="mt-3 space-y-2">
              {FACTOR_ORDER.map((key) => (
                <FactorRow
                  key={key}
                  factor={key}
                  value={profile.advanced?.mult?.[key] ?? 1}
                  onChange={(v) =>
                    setAdvanced({ mult: { ...(profile.advanced?.mult ?? {}), [key]: v } })
                  }
                />
              ))}
            </div>

            <RangeEditor
              key={`air-${rangeKey}`}
              label="Ideal air temperature"
              value={profile.advanced?.airIdeal ?? roundRange(opts.ideals.airPlateau)}
              min={40}
              max={110}
              onChange={(range) => setAdvanced({ airIdeal: range })}
            />
            <RangeEditor
              key={`water-${rangeKey}`}
              label="Ideal water temperature"
              value={profile.advanced?.waterIdeal ?? roundRange(opts.ideals.waterPlateau)}
              min={50}
              max={95}
              onChange={(range) => setAdvanced({ waterIdeal: range })}
            />

            <fieldset className="mt-4">
              <legend className="text-sm font-medium text-slate-800 dark:text-slate-200">
                Waves
              </legend>
              <div className="mt-2 flex flex-wrap gap-2">
                {WAVE_CHOICES.map((c) => (
                  <Chip
                    key={c.value}
                    selected={(profile.advanced?.wavePref ?? opts.ideals.waveMode) === c.value}
                    onClick={() => setAdvanced({ wavePref: c.value })}
                  >
                    {c.label}
                  </Chip>
                ))}
              </div>
            </fieldset>

            {profile.advanced ? (
              <div className="mt-3">
                <SecondaryButton onClick={resetAdvanced}>
                  Reset to {profile.profiles[0] ? profileChip(profile.profiles[0]) : "the defaults"}
                </SecondaryButton>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* --- Home beach ---------------------------------------------------- */}
      <div className="mt-5 border-t border-slate-900/10 pt-4 dark:border-white/10">
        <label
          htmlFor="plus-home-beach"
          className="block text-sm font-semibold text-slate-900 dark:text-white"
        >
          Home beach
        </label>
        <p className="mt-0.5 text-xs leading-snug text-slate-500 dark:text-slate-400">
          Where the app opens, and which beach the daily alerts talk about.
        </p>
        <select
          id="plus-home-beach"
          value={home ?? ""}
          onChange={(e) => void pickHome(e.target.value)}
          className={`mt-2 ${inputClass}`}
        >
          <option value="" disabled>
            Choose a beach
          </option>
          {beaches.map((b) => (
            <option key={b.slug} value={b.slug}>
              {b.name} — {b.region}
            </option>
          ))}
        </select>
      </div>

      {/* --- Alerts (app only) --------------------------------------------- */}
      {native ? (
        <div className="mt-5 border-t border-slate-900/10 pt-4 dark:border-white/10">
          <h3 className="text-sm font-semibold text-slate-900 dark:text-white">Alerts</h3>
          {ALERT_GROUPS.map((group) => (
            <div key={group.title} className="mt-3">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                {group.title}
              </h4>
              <div className="mt-1 space-y-1">
                {group.keys.map((key) => (
                  <AlertToggle
                    key={key}
                    label={ALERT_LABELS[key]}
                    on={plus.prefs[key]}
                    onChange={(on) => void toggleAlert(key, on)}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {/* --- Account ------------------------------------------------------- */}
      <div className="mt-5 space-y-2 border-t border-slate-900/10 pt-4 dark:border-white/10">
        {codeOpen ? (
          <div className="rounded-2xl bg-slate-900/5 p-3 dark:bg-white/5">
            <label
              htmlFor="plus-settings-code"
              className="block text-xs font-medium text-slate-600 dark:text-slate-300"
            >
              Your code
            </label>
            <input
              id="plus-settings-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              className={`mt-1 ${inputClass}`}
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
      </div>

      {note ? (
        <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">{note}</p>
      ) : null}
      <ErrorLine message={error} />
    </Sheet>
  );
}

function roundRange(range: [number, number]): [number, number] {
  return [Math.round(range[0]), Math.round(range[1])];
}

/** One Advanced row: a factor and how much it counts. A select rather than five
 *  buttons — five word-labels do not fit across a 390 px phone without being cut,
 *  and a native picker is the bigger tap target anyway. */
function FactorRow({
  factor,
  value,
  onChange,
}: {
  factor: SubKey;
  value: FactorMultiplier;
  onChange: (v: FactorMultiplier) => void;
}) {
  const id = `factor-${factor}`;
  return (
    <div className="flex items-center justify-between gap-3">
      <label htmlFor={id} className="min-w-0 flex-1 text-sm text-slate-700 dark:text-slate-300">
        {FACTOR_LABELS[factor]}
      </label>
      <select
        id={id}
        value={String(value)}
        onChange={(e) => onChange(Number(e.target.value) as FactorMultiplier)}
        className="min-h-[44px] w-[9.5rem] shrink-0 rounded-xl border-0 bg-white px-2 py-2 text-sm text-slate-900 ring-1 ring-slate-900/10 dark:bg-slate-800 dark:text-white dark:ring-white/10"
      >
        {MULTIPLIER_STOPS.map((stop) => (
          <option key={stop.value} value={String(stop.value)}>
            {stop.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/** Two numbers that must stay in order. Held locally while typing so clearing a
 *  field does not immediately write a nonsense range. */
function RangeEditor({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: [number, number];
  min: number;
  max: number;
  onChange: (range: [number, number]) => void;
}) {
  const [lo, setLo] = useState(String(value[0]));
  const [hi, setHi] = useState(String(value[1]));

  const commit = (nextLo: string, nextHi: string) => {
    const a = Number(nextLo);
    const b = Number(nextHi);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return;
    if (a < min || b > max || b < a) return;
    onChange([a, b]);
  };

  return (
    <div className="mt-4">
      <span className="block text-sm font-medium text-slate-800 dark:text-slate-200">{label}</span>
      <div className="mt-2 flex items-center gap-2">
        <input
          type="number"
          inputMode="numeric"
          aria-label={`${label}, low`}
          value={lo}
          min={min}
          max={max}
          onChange={(e) => {
            setLo(e.target.value);
            commit(e.target.value, hi);
          }}
          className={inputClass}
        />
        <span className="shrink-0 text-sm text-slate-500">to</span>
        <input
          type="number"
          inputMode="numeric"
          aria-label={`${label}, high`}
          value={hi}
          min={min}
          max={max}
          onChange={(e) => {
            setHi(e.target.value);
            commit(lo, e.target.value);
          }}
          className={inputClass}
        />
        <span className="shrink-0 text-sm text-slate-500">°F</span>
      </div>
    </div>
  );
}

function AlertToggle({
  label,
  on,
  onChange,
}: {
  label: string;
  on: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
      className="flex min-h-[44px] w-full items-center justify-between gap-3 rounded-xl px-1 text-left transition hover:bg-slate-900/5 dark:hover:bg-white/5"
    >
      <span className="min-w-0 flex-1 text-sm text-slate-700 dark:text-slate-300">{label}</span>
      <span
        aria-hidden
        className={`flex h-6 w-11 shrink-0 items-center rounded-full p-0.5 transition ${
          on ? "bg-ocean-600" : "bg-slate-300 dark:bg-slate-600"
        }`}
      >
        <span
          className={`h-5 w-5 rounded-full bg-white transition ${on ? "translate-x-5" : ""}`}
        />
      </span>
    </button>
  );
}
