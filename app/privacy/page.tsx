import type { Metadata } from "next";
import Link from "next/link";
import { Logo } from "@/components/Logo";
import { ThemeToggle } from "@/components/ThemeToggle";

const EFFECTIVE_DATE = "July 28, 2026";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description:
    "How Is It Beach Day handles data: no accounts, no sign-in, cookieless analytics, and exactly what a push notification token is used for.",
  alternates: { canonical: "https://isitbeachday.com/privacy" },
  openGraph: {
    title: "Privacy Policy · Is It Beach Day?",
    description:
      "How Is It Beach Day handles data: no accounts, no sign-in, cookieless analytics, and exactly what a push notification token is used for.",
    url: "https://isitbeachday.com/privacy",
    images: [{ url: "https://isitbeachday.com/opengraph-image", width: 1200, height: 630, alt: "Is It Beach Day?" }],
  },
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-8">
      <h2 className="text-lg font-semibold text-slate-900 dark:text-white">{title}</h2>
      <div className="mt-2 space-y-3 text-sm leading-relaxed text-slate-600 dark:text-slate-400">
        {children}
      </div>
    </section>
  );
}

export default function PrivacyPage() {
  return (
    <main className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
      <header className="mb-6 flex items-center justify-between">
        <Link href="/" className="inline-flex items-center hover:opacity-80" aria-label="Is It Beach Day — home">
          <Logo markSize={28} />
        </Link>
        <ThemeToggle />
      </header>

      <h1 className="text-3xl font-bold tracking-tight text-slate-900 dark:text-white sm:text-4xl">
        Privacy Policy
      </h1>
      <p className="mt-2 text-sm text-slate-500 dark:text-slate-500">
        Effective {EFFECTIVE_DATE}
      </p>
      <p className="mt-4 max-w-2xl text-slate-600 dark:text-slate-400">
        Is It Beach Day shows public environmental data — weather, tides, webcams,
        satellite reads — for beaches across the US. There are no accounts and no
        sign-in. This page lays out, plainly, the little we do collect and why.
      </p>

      <Section title="Browsing the site">
        <p>
          You can use the website and read every beach&apos;s conditions without
          creating an account, signing in, or handing over any personal
          information. We don&apos;t know who you are.
        </p>
      </Section>

      <Section title="Push notifications (app only)">
        <p>
          In the iOS/Android app, you can opt in to &quot;Notify me&quot; for a beach —
          a morning Beach Day summary and/or safety alerts. Turning this on stores
          your device&apos;s push token (an APNs token on iOS, an FCM token on
          Android) in our database, tied to the beach you picked and your on/off
          preferences. Nothing else is attached to it — no name, no email, no
          account, no identity of any kind.
        </p>
        <p>
          Deleting the app, or turning notifications off, ends it — the token is
          removed. We only ever send the notifications you opted into; there are
          no marketing pushes.
        </p>
      </Section>

      <Section title="Location">
        <p>
          The app and site never read your device&apos;s location automatically.
          The one exception is the &quot;Find your beach&quot; page: if you tap
          &quot;Use my location,&quot; your browser asks permission and, if you
          allow it, uses your coordinates to sort the beach list by distance —
          entirely in your browser. That location is never sent to our servers or
          stored anywhere. Skip the button and nothing is requested.
        </p>
      </Section>

      <Section title="Beach cams">
        <p>
          The webcams shown on the site are public cameras operated by third
          parties (cities, resorts, and public webcam networks) — we don&apos;t
          run them. We fetch their public frames to compute aggregate,
          non-identifying conditions: how much seaweed is visible, how busy the
          beach looks, how clear the water is. There&apos;s no facial recognition
          and no attempt to identify anyone in a frame, and we don&apos;t publish
          or redistribute the images beyond what the camera operators already
          make public.
        </p>
      </Section>

      <Section title="Analytics">
        <p>
          We use Cloudflare Web Analytics to see aggregate traffic (how many
          people visited, which pages). It&apos;s cookieless, doesn&apos;t track
          you across other sites, and doesn&apos;t build an advertising profile.
          We run no ads and use no ad trackers.
        </p>
      </Section>

      <Section title="What we share">
        <p>
          We don&apos;t sell or share your data with anyone — there isn&apos;t a
          data broker relationship to opt out of. The conditions on each beach
          page are pulled from public data sources (NOAA, the National Weather
          Service, Open-Meteo, EPA AirNow, MET Norway, and similar), which are
          listed on that beach&apos;s page under &quot;Data sources.&quot; We
          don&apos;t send your information to them — we only read their public
          data.
        </p>
      </Section>

      <Section title="Children">
        <p>
          The site collects no personal information from anyone, including
          children, beyond the anonymous push token described above.
        </p>
      </Section>

      <Section title="Changes">
        <p>
          If this policy changes in a meaningful way, we&apos;ll update the
          effective date above.
        </p>
      </Section>

      <Section title="Contact">
        <p>
          Questions about any of this?{" "}
          <a
            href="mailto:support@isitbeachday.com"
            className="text-ocean-700 hover:underline dark:text-ocean-300"
          >
            support@isitbeachday.com
          </a>
        </p>
      </Section>

      <p className="mt-10 text-center text-xs text-slate-400 dark:text-slate-600">
        <Link href="/" className="hover:underline">
          ← Back to Is It Beach Day
        </Link>
      </p>
    </main>
  );
}
