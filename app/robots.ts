import type { MetadataRoute } from "next";

// Served at /robots.txt. Nothing here is private — let every crawler in and
// point them at the sitemap.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", allow: "/" },
    sitemap: "https://isitbeachday.com/sitemap.xml",
  };
}
