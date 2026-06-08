import type { MetadataRoute } from "next";

// Served at /manifest.webmanifest; Next injects the <link> automatically.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Boca Beach Rats",
    short_name: "Beach Rats",
    description:
      "Live South Florida beach conditions — tides, water & air temp, wind, waves, water quality, cams — distilled into a single Beach Day score.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#061826",
    theme_color: "#061826",
    orientation: "portrait",
    categories: ["weather", "travel", "lifestyle"],
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-maskable.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
