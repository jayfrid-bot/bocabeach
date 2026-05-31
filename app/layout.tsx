import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { Anton, Oswald, Barlow } from "next/font/google";
import { ThemeProvider } from "@/components/ThemeProvider";
import "./globals.css";

const anton = Anton({
  weight: "400",
  subsets: ["latin"],
  variable: "--font-anton",
  display: "swap",
});
const oswald = Oswald({
  subsets: ["latin"],
  variable: "--font-oswald",
  display: "swap",
});
const barlow = Barlow({
  weight: ["400", "600", "700"],
  subsets: ["latin"],
  variable: "--font-barlow",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Boca Beach Rats",
  description:
    "Live South Florida beach conditions — tides, water & air temp, wind, waves, water quality, cams — distilled into a single Beach Day score.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f4e4c1" },
    { media: "(prefers-color-scheme: dark)", color: "#0e1822" },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${anton.variable} ${oswald.variable} ${barlow.variable}`}
    >
      <body className="min-h-screen font-body text-ink antialiased">
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
