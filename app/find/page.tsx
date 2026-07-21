import type { Metadata } from "next";
import Link from "next/link";
import { listLocations, toPublicLocation } from "@/config/locations";
import { Logo } from "@/components/Logo";
import { ThemeToggle } from "@/components/ThemeToggle";
import { BeachFinder } from "@/components/BeachFinder";

export const revalidate = 300;

export const metadata: Metadata = {
  title: "Find your beach",
  description:
    "Search live beach conditions across the US or find the beaches nearest you. One Beach Day score per beach: tides, water & air temp, wind, waves, UV, water quality, and NWS safety alerts.",
  alternates: { canonical: "https://isitbeachday.com/find" },
  openGraph: {
    title: "Find your beach · Is It Beach Day?",
    description:
      "Search live beach conditions across the US or find the beaches nearest you. One Beach Day score per beach.",
    url: "https://isitbeachday.com/find",
    // Next does not deep-merge openGraph, so re-declare the share image here.
    images: [{ url: "https://isitbeachday.com/opengraph-image", width: 1200, height: 630, alt: "Is It Beach Day?" }],
  },
};

export default function FindPage() {
  const beaches = listLocations().map(toPublicLocation);

  return (
    <main className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
      <header className="mb-6 flex items-center justify-between">
        <Link href="/" className="inline-flex items-center hover:opacity-80" aria-label="Is It Beach Day — home">
          <Logo markSize={28} />
        </Link>
        <ThemeToggle />
      </header>

      <h1 className="text-3xl font-bold tracking-tight text-slate-900 dark:text-white sm:text-4xl">
        Find your beach
      </h1>
      <p className="mb-6 mt-2 max-w-2xl text-slate-600 dark:text-slate-400">
        {beaches.length} beaches across the US, each with a live Beach Day score.
        Search by name, jump to the beaches nearest you, or browse by state.
      </p>

      <BeachFinder beaches={beaches} />

      <p className="mt-10 text-center text-xs text-slate-400 dark:text-slate-600">
        Don&apos;t see your beach?{" "}
        <a
          href="mailto:hello@isitbeachday.com"
          className="text-ocean-700 hover:underline dark:text-ocean-300"
        >
          Tell us where to add next
        </a>
      </p>
    </main>
  );
}
