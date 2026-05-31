import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Boca Beach Rats",
  description:
    "Live South Florida beach conditions — tides, water & air temp, wind, waves, water quality, cams — distilled into a single Beach Day score.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#061826",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen text-slate-100 antialiased">{children}</body>
    </html>
  );
}
