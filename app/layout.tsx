import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import { ServiceWorkerRegister } from "@/components/ServiceWorkerRegister";

export const metadata: Metadata = {
  title: "Is It Beach Day?",
  description:
    "One answer to one question: is it a beach day? Live tides, water & air temp, wind, waves, water quality, and cams — distilled into a single 0–100 Beach Day score.",
  applicationName: "Is It Beach Day",
  appleWebApp: {
    capable: true,
    title: "Is It Beach Day?",
    statusBarStyle: "black",
  },
  // Legacy iOS standalone flag (older Safari predates `mobile-web-app-capable`).
  other: { "apple-mobile-web-app-capable": "yes" },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f3f7fb" },
    { media: "(prefers-color-scheme: dark)", color: "#061826" },
  ],
  viewportFit: "cover",
};

// Applies the saved (or system) theme before first paint — no wrong-theme flash.
const THEME_SCRIPT = `(function(){try{var t=localStorage.getItem("theme");var d=t==="dark"||(t!=="light"&&matchMedia("(prefers-color-scheme: dark)").matches);document.documentElement.classList.toggle("dark",d);}catch(e){}})();`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="min-h-screen text-slate-900 antialiased dark:text-slate-100">
        {children}
        <ServiceWorkerRegister />
      </body>
    </html>
  );
}
