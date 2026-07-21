import type { MetadataRoute } from "next";

// Served at /robots.txt (host-agnostic). Let crawlers into the public pages but
// keep the admin console and internal JSON APIs out of the index, and point
// everyone at the canonical sitemap on the apex domain.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/admin", "/api"],
    },
    sitemap: "https://isitbeachday.com/sitemap.xml",
  };
}
