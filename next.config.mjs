/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  images: {
    // Cam thumbnails / external snapshots are loaded from third-party hosts.
    remotePatterns: [{ protocol: "https", hostname: "**" }],
  },
};

export default nextConfig;
