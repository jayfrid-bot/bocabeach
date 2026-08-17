import type { Metadata } from "next";
import Link from "next/link";
import { Logo } from "@/components/Logo";
import { ThemeToggle } from "@/components/ThemeToggle";

export const metadata: Metadata = {
  title: "Support",
  description:
    "How Is It Beach Day works: the honest-data philosophy, how fresh each source is, which beaches are covered, how notifications work, and how the score is computed.",
  alternates: { canonical: "https://isitbeachday.com/support" },
  openGraph: {
    title: "Support · Is It Beach Day?",
    description:
      "How Is It Beach Day works: the honest-data philosophy, how fresh each source is, and how the score is computed.",
    url: "https://isitbeachday.com/support",
    images: [{ url: "https://isitbeachday.com/opengraph-image", width: 1200, height: 630, alt: "Is It Beach Day?" }],
  },
};

function Faq({ q, children }: { q: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl bg-white/80 p-5 ring-1 ring-slate-900/10 dark:bg-slate-900/70 dark:ring-white/10">
      <h3 className="text-sm font-semibold text-slate-900 dark:text-white">{q}</h3>
      <div className="mt-2 space-y-2 text-sm leading-relaxed text-slate-600 dark:text-slate-400">
        {children}
      </div>
    </div>
  );
}

export default function SupportPage() {
  return (
    <main className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
      <header className="mb-6 flex items-center justify-between">
        <Link href="/" className="inline-flex items-center hover:opacity-80" aria-label="Is It Beach Day — home">
          <Logo markSize={28} />
        </Link>
        <ThemeToggle />
      </header>

      <h1 className="text-3xl font-bold tracking-tight text-slate-900 dark:text-white sm:text-4xl">
        Support
      </h1>
      <p className="mt-4 max-w-2xl text-slate-600 dark:text-slate-400">
        Is It Beach Day distills live tides, weather, water and sand temperature,
        rip current risk, seaweed, lightning, crowds, and beach webcams into one
        0–100 Beach Day score per beach — so you can tell, at a glance, whether
        today&apos;s worth the drive.
      </p>

      <div className="mt-8 space-y-4">
        <Faq q="Why does a metric say “unknown”?">
          <p>
            Because we&apos;d rather tell you the truth than guess. If the cams
            can&apos;t see the beach (night, or a stale capture), busyness and
            water clarity read &quot;unknown&quot; instead of faking an empty,
            clear beach. If a buoy or forecast feed is down, that metric drops
            out rather than showing a made-up number. An &quot;unknown&quot;
            metric is never scored — it&apos;s simply absent.
          </p>
        </Faq>

        <Faq q="How fresh is the data?">
          <p>Every source refreshes on its own cadence:</p>
          <ul className="list-disc space-y-1 pl-5">
            <li>Tide gauge readings — every 6 minutes</li>
            <li>Lightning — about every 30 seconds</li>
            <li>Beach cams (busyness, seaweed, clarity) — about every 10 minutes</li>
            <li>Buoy water temperature — about every 10 minutes</li>
            <li>NWS alerts — about every 15 minutes</li>
            <li>Weather, tide predictions, and air quality — hourly to a few times a day</li>
          </ul>
          <p>
            Each beach page shows exactly when each source was last fetched, in
            the &quot;Data sources&quot; panel at the bottom.
          </p>
        </Faq>

        <Faq q="Which beaches are covered?">
          <p>
            We&apos;re adding US beaches over time.{" "}
            <Link href="/find" className="text-ocean-700 hover:underline dark:text-ocean-300">
              Search or browse the full list
            </Link>
            . Don&apos;t see yours? Email us the spot and we&apos;ll look at
            adding it.
          </p>
        </Faq>

        <Faq q="How do notifications work?">
          <p>
            In the iOS/Android app, tap &quot;Notify me&quot; on a beach to opt
            in to a morning Beach Day summary, safety alerts, or both. It&apos;s
            app-only (no notifications in a browser), entirely opt-in, and we
            never send marketing pushes — just what you asked for. Turn it off
            any time from the same button.
          </p>
        </Faq>

        <Faq q="How is the score computed?">
          <p>
            The Beach Day score blends water and air conditions, rip risk,
            lightning, seaweed, crowds, and any active safety advisories into one
            0–100 number, with a plain-English &quot;why this score&quot;
            breakdown underneath it.
          </p>
          <p>
            For the exact math behind any individual metric, tap the card on a
            beach page — it flips over to show the raw numbers, the source, and
            the formula.{" "}
            <Link href="/" className="text-ocean-700 hover:underline dark:text-ocean-300">
              See it on a beach page →
            </Link>
          </p>
        </Faq>
      </div>

      <section className="mt-10 rounded-2xl bg-white/80 p-5 text-center ring-1 ring-slate-900/10 dark:bg-slate-900/70 dark:ring-white/10">
        <h2 className="text-sm font-semibold text-slate-900 dark:text-white">
          Get the app
        </h2>
        <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">
          Is It Beach Day is free on the App Store, with the same live score plus notifications.
        </p>
        <a
          href="https://apps.apple.com/us/app/id6779072992"
          target="_blank"
          rel="noopener noreferrer"
          className="mt-3 inline-flex focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ocean-500/70 focus-visible:ring-offset-2 focus-visible:ring-offset-transparent"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/app-store-badge.svg" alt="Download on the App Store" width={120} height={40} />
        </a>
      </section>

      <section className="mt-6 rounded-2xl bg-white/80 p-5 text-center ring-1 ring-slate-900/10 dark:bg-slate-900/70 dark:ring-white/10">
        <h2 className="text-sm font-semibold text-slate-900 dark:text-white">
          Still stuck?
        </h2>
        <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">
          Spot something off, have an idea, or just want to say hi —{" "}
          <a
            href="mailto:support@isitbeachday.com"
            className="text-ocean-700 hover:underline dark:text-ocean-300"
          >
            support@isitbeachday.com
          </a>
        </p>
      </section>

      <p className="mt-10 text-center text-xs text-slate-400 dark:text-slate-600">
        <Link href="/" className="hover:underline">
          ← Back to Is It Beach Day
        </Link>
      </p>
    </main>
  );
}
