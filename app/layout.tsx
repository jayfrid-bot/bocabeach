import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Boca Beach Conditions",
  description:
    "Live Boca Raton beach conditions — tides, water & air temp, wind, waves, cams — with a composite Surf / Beach Day score.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen text-slate-100 antialiased">{children}</body>
    </html>
  );
}
