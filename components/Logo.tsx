// Brand logo for "Is It Beach Day" — a sun-over-waves mark plus optional wordmark.
// Pure inline SVG so it ships with zero requests and inherits layout sizing.

export function LogoMark({ size = 36 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 512 512"
      role="img"
      aria-hidden
      className="shrink-0 rounded-xl"
    >
      <defs>
        <linearGradient id="lg-sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#1758b6" />
          <stop offset="0.55" stopColor="#142f57" />
          <stop offset="1" stopColor="#061826" />
        </linearGradient>
        <radialGradient id="lg-sun" cx="0.5" cy="0.4" r="0.75">
          <stop offset="0" stopColor="#ffe9a8" />
          <stop offset="0.55" stopColor="#ffd76e" />
          <stop offset="1" stopColor="#fbbf24" />
        </radialGradient>
        <linearGradient id="lg-wave" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#59c1ff" />
          <stop offset="1" stopColor="#1b85f5" />
        </linearGradient>
      </defs>
      <rect width="512" height="512" fill="url(#lg-sky)" />
      <g stroke="#fbbf24" strokeWidth="22" strokeLinecap="round" opacity="0.9">
        <line x1="256" y1="64" x2="256" y2="104" />
        <line x1="146" y1="110" x2="174" y2="138" />
        <line x1="366" y1="110" x2="338" y2="138" />
        <line x1="100" y1="220" x2="140" y2="220" />
        <line x1="412" y1="220" x2="372" y2="220" />
      </g>
      <circle cx="256" cy="220" r="86" fill="url(#lg-sun)" />
      <path
        d="M0 312 Q 64 280 128 312 T 256 312 T 384 312 T 512 312 V 512 H 0 Z"
        fill="url(#lg-wave)"
      />
      <path
        d="M0 392 Q 64 360 128 392 T 256 392 T 384 392 T 512 392 V 512 H 0 Z"
        fill="#146de1"
        opacity="0.95"
      />
    </svg>
  );
}

/** Mark + wordmark lockup; the "?" carries the brand question in sun gold. */
export function Logo({ markSize = 36 }: { markSize?: number }) {
  return (
    <span className="inline-flex items-center gap-2.5">
      <LogoMark size={markSize} />
      <span className="whitespace-nowrap font-bold tracking-tight text-slate-900 dark:text-white">
        Is it beach day<span className="text-amber-400">?</span>
      </span>
    </span>
  );
}
