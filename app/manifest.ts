import type { MetadataRoute } from "next";

// Served at /manifest.webmanifest; Next injects the <link> automatically.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Is It Beach Day",
    short_name: "Beach Day",
    description:
      "One answer to one question: is it a beach day? Live beach conditions distilled into a single 0–100 Beach Day score.",
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
