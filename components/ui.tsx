import type { CSSProperties, ReactNode } from "react";

const HAIRLINE = "1px solid color-mix(in srgb, var(--ink) 8%, transparent)";

/** Base card surface (foam background, soft shadow, hairline border). */
export function Surface({
  children,
  className = "",
  style,
}: {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <div
      className={`rounded-md bg-foam shadow-card ${className}`}
      style={{ border: HAIRLINE, ...style }}
    >
      {children}
    </div>
  );
}

type PillTone = "ink" | "sea" | "good" | "warn" | "danger";

const PILL_TONES: Record<PillTone, CSSProperties> = {
  ink: { background: "color-mix(in srgb, var(--ink) 8%, transparent)", color: "var(--ink)" },
  sea: { background: "color-mix(in srgb, var(--sea) 14%, transparent)", color: "var(--sea-deep)" },
  good: { background: "color-mix(in srgb, var(--score-good) 16%, transparent)", color: "var(--score-good)" },
  warn: { background: "color-mix(in srgb, var(--sun) 18%, transparent)", color: "var(--ink)" },
  danger: { background: "color-mix(in srgb, var(--coral) 16%, transparent)", color: "var(--coral)" },
};

/** Small status chip. */
export function Pill({
  children,
  tone = "ink",
}: {
  children: ReactNode;
  tone?: PillTone;
}) {
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-head text-xs font-semibold"
      style={PILL_TONES[tone]}
    >
      {children}
    </span>
  );
}

/** Section heading with an optional uppercase kicker. */
export function SectionTitle({
  children,
  kicker,
}: {
  children: ReactNode;
  kicker?: string;
}) {
  return (
    <div className="mb-3">
      {kicker ? (
        <div className="font-head text-xs font-bold uppercase tracking-[0.08em] text-sea-deep">
          {kicker}
        </div>
      ) : null}
      <h2 className="font-head text-xl font-semibold text-ink sm:text-2xl">{children}</h2>
    </div>
  );
}
