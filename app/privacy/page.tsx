import type { Metadata } from "next";
import Link from "next/link";
import { Logo } from "@/components/Logo";
import { ThemeToggle } from "@/components/ThemeToggle";

const EFFECTIVE_DATE = "September 2, 2026";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description:
    "How Is It Beach Day handles data: no accounts, no sign-in, cookieless analytics, and exactly what location and push notification data Beach Day Plus uses.",
  alternates: { canonical: "https://isitbeachday.com/privacy" },
  openGraph: {
    title: "Privacy Policy · Is It Beach Day?",
    description:
      "How Is It Beach Day handles data: no accounts, no sign-in, cookieless analytics, and exactly what location and push notification data Beach Day Plus uses.",
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
          a morning Beach Day summary and, with Beach Day Plus, safety alerts.
          Turning this on stores your device&apos;s push token (an APNs token on
          iOS, an FCM token on Android) in our database, tied to a random device
          id — see &quot;Location and your device id&quot; below for what else that
          id carries. Nothing personal is attached — no name, no email, no
          account, no identity of any kind.
        </p>
        <p>
          Deleting the app, or turning notifications off, ends it — the token is
          removed. We only ever send the notifications you opted into; there are
          no marketing pushes.
        </p>
      </Section>

      <Section title="Location and your device id">
        <p>
          The app and site read your location only when you ask them to — never
          automatically, and never in the background.
        </p>
        <p>
          Tapping &quot;Find my nearest beach&quot; — on the website&apos;s Find
          your beach page, or the one-line banner the app shows on first launch —
          asks your browser or device for a location fix, used only to sort the
          beach list or set your home beach by distance. That fix is used
          entirely on your device. It is never sent to our servers or stored.
          Skip the button and nothing is requested.
        </p>
        <p>
          Turning on Beach Mode — a Beach Day Plus feature that arms hazard
          alerts for where you&apos;re actually standing, not just your home
          beach — is different. Your device&apos;s position (latitude, longitude,
          accuracy, and the time of the fix) is sent to our server and kept with
          your device record for as long as alerts are armed, at most 8 hours,
          so alerts can be computed for where you really are. Turning Beach Mode
          off removes that position right away.
        </p>
        <p>
          A random device id — no account, no name, no email — ties your score
          profile, alert settings, and Plus status to your device, the same way
          the push token above does. There is still no sign-in. Deleting the app
          clears all of it.
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
          children, beyond the anonymous device data described above.
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
