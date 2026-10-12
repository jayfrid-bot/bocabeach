// Typed accessor for the Workers AI binding (`AI`, see wrangler.jsonc).
//
// Fail closed: when the binding is absent (plain `next dev`, tests, a deploy
// that forgot it) this returns null and the route answers 503. Reached the same
// way lib/camFrames/r2.ts reaches R2: a STATIC top-level import of
// @opennextjs/cloudflare plus the async form of getCloudflareContext.

import { getCloudflareContext } from "@opennextjs/cloudflare";
import type { AiBindingLike, ClefEnv } from "@/lib/vision/clef";

export async function getAiBinding(): Promise<AiBindingLike | null> {
  try {
    const ctx = await getCloudflareContext({ async: true });
    const ai = (ctx?.env as ClefEnv | undefined)?.AI;
    return ai && typeof ai.run === "function" ? ai : null;
  } catch {
    return null; // no bindings (plain `next dev`, tests) -> fail closed
  }
}
