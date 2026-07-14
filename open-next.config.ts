import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// Cloudflare Workers adapter for Next.js (OpenNext). Keeps the Node.js runtime
// (the push sender uses node:crypto + Buffer) and Next's ISR/caching. Push
// device tokens live in the PUSH_KV namespace bound in wrangler.jsonc; see
// lib/push/nativeStore.ts for the KV-first storage backend.
export default defineCloudflareConfig();
