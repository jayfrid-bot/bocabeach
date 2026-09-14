import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./", import.meta.url)),
    },
  },
  // The share-card image route (app/api/share/[slug]/route.tsx) is JSX built
  // for next/og's satori renderer; its route.test.ts imports it directly, so
  // esbuild needs to compile that .tsx the same way Next does (automatic JSX
  // runtime, no `React` global required) rather than assume no test ever
  // touches JSX. tsconfig's "jsx": "preserve" is for Next's own compiler and
  // doesn't reach esbuild here.
  esbuild: {
    jsx: "automatic",
  },
  test: {
    environment: "node",
    include: ["**/*.test.ts"],
    globals: true,
  },
});
