import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // Nautical "Lifeguard Tower" tokens — driven by CSS vars so the
        // light ("day") / dark ("night") themes flip via [data-theme].
        sand: "var(--sand)",
        "sand-deep": "var(--sand-deep)",
        "sand-line": "var(--sand-line)",
        foam: "var(--foam)",
        paper: "var(--paper)",
        "paper-alt": "var(--paper-alt)",
        ink: "var(--ink)",
        "ink-soft": "var(--ink-soft)",
        "ink-faint": "var(--ink-faint)",
        sea: "var(--sea)",
        "sea-deep": "var(--sea-deep)",
        "sea-glow": "var(--sea-glow)",
        teal: "var(--teal)",
        coral: "var(--coral)",
        sun: "var(--sun)",
        // legacy accent kept so the landing page / back-link still resolve
        ocean: {
          300: "#7dd3fc",
          500: "#0ea5e9",
          600: "#0284c7",
        },
      },
      fontFamily: {
        display: "var(--font-display)",
        head: "var(--font-head)",
        body: "var(--font-body)",
      },
      borderRadius: {
        lg: "var(--radius-lg)",
        md: "var(--radius-md)",
        sm: "var(--radius-sm)",
      },
      boxShadow: {
        card: "var(--shadow-card)",
        soft: "var(--shadow-soft)",
      },
    },
  },
  plugins: [],
};

export default config;
