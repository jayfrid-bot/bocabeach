import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import { ServiceWorkerRegister } from "@/components/ServiceWorkerRegister";
import { NativePushInit } from "@/components/NativePushInit";

const SITE_URL = "https://isitbeachday.com";
const DEFAULT_TITLE = "Is It Beach Day? — Live Beach Conditions & Score";
const DESCRIPTION =
  "Is it a beach day? Get the live Beach Day score for US beaches — water temperature, sand temperature, rip currents, seaweed/sargassum, lightning, crowds, and webcams, distilled into one 0–100 answer.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: DEFAULT_TITLE,
    template: "%s · Is It Beach Day?",
  },
  description: DESCRIPTION,
  applicationName: "Is It Beach Day",
  appleWebApp: {
    capable: true,
    title: "Is It Beach Day?",
    statusBarStyle: "black",
  },
  // Legacy iOS standalone flag (older Safari predates `mobile-web-app-capable`).
  other: { "apple-mobile-web-app-capable": "yes" },
  formatDetection: { telephone: false },
  openGraph: {
    type: "website",
    title: DEFAULT_TITLE,
    description: DESCRIPTION,
    url: SITE_URL,
    siteName: "Is It Beach Day",
    images: [{ url: "/opengraph-image", width: 1200, height: 630, alt: "Is It Beach Day?" }],
  },
  twitter: {
    card: "summary_large_image",
    title: DEFAULT_TITLE,
    description: DESCRIPTION,
    images: ["/opengraph-image"],
  },
};

// Site-wide structured data: identifies the site + publisher to search engines.
// Kept honest — name, url, logo only; no fabricated ratings anywhere on the site.
const JSON_LD = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "WebSite",
      name: "Is It Beach Day?",
      alternateName: "isitbeachday",
      url: SITE_URL,
    },
    {
      "@type": "Organization",
      name: "Is It Beach Day?",
      url: SITE_URL,
      logo: `${SITE_URL}/icon-512.png`,
    },
  ],
};

// JSON.stringify, then neutralize any "</script>" sequence so the block can't
// break out of its <script> tag (defence-in-depth; our data has no user input).
function ldJson(data: unknown): string {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // A media-scoped theme-color tracks the OS, so PWA chrome desyncs after a
  // manual in-app toggle. We ship one neutral default here and keep the meta
  // tag synced to the RESOLVED theme via the pre-paint script + ThemeToggle.
  themeColor: "#f3f7fb",
  viewportFit: "cover",
};

// Applies the saved (or system) theme before first paint — no wrong-theme flash —
// and syncs the <meta name="theme-color"> to the RESOLVED theme so PWA chrome
// matches the in-app override (not just the OS). ThemeToggle re-syncs on toggle.
const THEME_SCRIPT = `(function(){try{var t=localStorage.getItem("theme");var d=t==="dark"||(t!=="light"&&matchMedia("(prefers-color-scheme: dark)").matches);document.documentElement.classList.toggle("dark",d);var sync=function(){var c=document.documentElement.classList.contains("dark")?"#020617":"#f3f7fb";var ms=document.querySelectorAll('meta[name="theme-color"]');if(ms.length){ms.forEach(function(m){m.setAttribute("content",c);});}else{var m=document.createElement("meta");m.name="theme-color";m.setAttribute("content",c);document.head.appendChild(m);}};sync();if(document.readyState==="loading"){document.addEventListener("DOMContentLoaded",sync);}}catch(e){}})();`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
        {/* Cloudflare Web Analytics — privacy-friendly, cookieless page views. */}
        <script
          defer
          src="https://static.cloudflareinsights.com/beacon.min.js"
          data-cf-beacon='{"token": "32074e9abf544275a8851422ee2356b6"}'
        />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: ldJson(JSON_LD) }}
        />
      </head>
      <body className="min-h-screen text-slate-900 antialiased dark:text-slate-100">
        {children}
        <ServiceWorkerRegister />
        <NativePushInit />
      </body>
    </html>
  );
}
