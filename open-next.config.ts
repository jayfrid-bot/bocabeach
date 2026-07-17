import { defineCloudflareConfig } from "@opennextjs/cloudflare";
import kvIncrementalCache from "@opennextjs/cloudflare/overrides/incremental-cache/kv-incremental-cache";

// Cloudflare Workers adapter for Next.js (OpenNext). Keeps the Node.js runtime
// (the push sender uses node:crypto + Buffer) and Next's ISR/caching. Push
// device tokens live in the PUSH_KV namespace bound in wrangler.jsonc; see
// lib/push/nativeStore.ts for the KV-first storage backend.
//
// incrementalCache → KV (binding NEXT_INC_CACHE_KV): without this, ISR and
// unstable_cache are no-ops on Workers, so the force-dynamic pages re-ran the
// full conditions pipeline (18 fetches + 192-hour scoring) on EVERY request and
// tipped the worker over its resource limit (Cloudflare error 1102) under load.
// getConditions() is wrapped in unstable_cache (lib/conditions.ts), so the heavy
// work now runs at most once per ~2 min per beach and is served from KV otherwise.
export default defineCloudflareConfig({
  incrementalCache: kvIncrementalCache,
});
