import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import { ServiceWorkerRegister } from "@/components/ServiceWorkerRegister";
import { NativePushInit } from "@/components/NativePushInit";
import { NativeDiag } from "@/components/NativeDiag";

const SITE_URL = "https://isitbeachday.com";
const DESCRIPTION =
  "One answer to one question: is it a beach day? Live tides, water & air temp, wind, waves, water quality, and cams — distilled into a single 0–100 Beach Day score.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: "Is It Beach Day?",
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
    title: "Is It Beach Day?",
    description: DESCRIPTION,
    url: SITE_URL,
    siteName: "Is It Beach Day",
    images: [{ url: "/icon-512.png", width: 512, height: 512, alt: "Is It Beach Day?" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Is It Beach Day?",
    description: DESCRIPTION,
    images: ["/icon-512.png"],
  },
};

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
      </head>
      <body className="min-h-screen text-slate-900 antialiased dark:text-slate-100">
        {children}
        <NativeDiag />
        <ServiceWorkerRegister />
        <NativePushInit />
      </body>
    </html>
  );
}
