import { readFileSync } from "node:fs";

// Read the app version from package.json and stamp the build time, both baked
// into the bundle at build so the footer can show "which build + how fresh".
const pkg = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
);

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  images: {
    // Cam thumbnails / external snapshots are loaded from third-party hosts.
    remotePatterns: [{ protocol: "https", hostname: "**" }],
  },
  env: {
    // Inlined at build (available in client components via process.env.*).
    NEXT_PUBLIC_APP_VERSION: pkg.version,
    NEXT_PUBLIC_BUILD_TIME: new Date().toISOString(),
  },
};

export default nextConfig;
