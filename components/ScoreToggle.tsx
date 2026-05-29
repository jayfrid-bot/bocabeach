"use client";

export type ScoreMode = "beachDay" | "surf";

export function ScoreToggle({
  mode,
  onChange,
}: {
  mode: ScoreMode;
  onChange: (m: ScoreMode) => void;
}) {
  const options: { key: ScoreMode; label: string }[] = [
    { key: "beachDay", label: "🏖️ Beach Day" },
    { key: "surf", label: "🏄 Surf" },
  ];
  return (
    <div className="inline-flex rounded-full bg-slate-800/80 p-1 ring-1 ring-white/10">
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          onClick={() => onChange(o.key)}
          className={`rounded-full px-4 py-1.5 text-sm font-medium transition ${
            mode === o.key
              ? "bg-ocean-600 text-white shadow"
              : "text-slate-300 hover:text-white"
          }`}
          aria-pressed={mode === o.key}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
