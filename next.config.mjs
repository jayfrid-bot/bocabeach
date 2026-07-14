import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

// Read the app version from package.json and stamp the build time, both baked
// into the bundle at build so the footer can show "which build + how fresh".
const pkg = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
);

// Auto-derived build identity from git: the commit COUNT gives an ever-increasing
// human build number (no manual bumping) and the short SHA pins the exact commit.
// pkg.version alone sat at 0.1.0 forever, so "v0.1.0" never said WHICH build.
const git = (cmd, fallback) => {
  try {
    return execSync(cmd, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim() || fallback;
  } catch {
    return fallback;
  }
};
const BUILD_NUM = git("git rev-list --count HEAD", "0");
const GIT_SHA = git("git rev-parse --short HEAD", "dev");

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
    NEXT_PUBLIC_BUILD_NUM: BUILD_NUM,
    NEXT_PUBLIC_GIT_SHA: GIT_SHA,
    NEXT_PUBLIC_BUILD_TIME: new Date().toISOString(),
  },
};

export default nextConfig;
