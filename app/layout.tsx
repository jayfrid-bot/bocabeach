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
  themeColor: "#061826",
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen text-slate-100 antialiased">
        {children}
        <ServiceWorkerRegister />
      </body>
    </html>
  );
}
