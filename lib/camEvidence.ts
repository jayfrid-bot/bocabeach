// What each configured cam's source says about its newest good frame, from the two
// public reads the owner's scorecard makes: uw-frame /cams (every courier cam in one
// answer) and one latest.json per county feed. Pure: the caller does the fetching.
// The page itself reads the same facts per cam in lib/cams.ts, through the same
// helpers (lib/camSnapshots.ts feedLastGood / metaLastGood).

import { feedLastGood, metaLastGood } from "@/lib/camSnapshots";
import type { CamAttempt, CamEvidence } from "@/lib/camStatus";
import type { CamConfig } from "@/lib/types";

/**
 * @param uwCams  the parsed uw-frame /cams answer, or undefined when it failed
 * @param feeds   latest.json per feed base (undefined = that read failed)
 */
export function camEvidenceFromSources(
  locations: readonly { cams: readonly CamConfig[] }[],
  uwCams: unknown,
  feeds: ReadonlyMap<string, unknown>,
): CamEvidence[] {
  const list = (uwCams as { cams?: unknown } | null | undefined)?.cams;
  const uwById = new Map(
    (Array.isArray(list) ? (list as Record<string, unknown>[]) : []).map((c) => [String(c?.id), c]),
  );
  const out: CamEvidence[] = [];
  for (const loc of locations) {
    for (const cam of loc.cams) {
      if (!cam.id || cam.embedType !== "image") continue;
      if (cam.snapshotMetaUrl) {
        const c = uwById.get(cam.id);
        if (!c) {
          out.push({ id: cam.id, lastGoodFrameAt: undefined });
          continue;
        }
        const att = c.lastAttempt as { grabbedAtUtc?: unknown; error?: unknown } | null | undefined;
        const lastAttempt: CamAttempt | null =
          att && typeof att.grabbedAtUtc === "string"
            ? { at: att.grabbedAtUtc, blank: /blank/i.test(String(att.error ?? "")) }
            : null;
        out.push({ id: cam.id, lastGoodFrameAt: metaLastGood(c), lastAttempt });
      } else if (cam.snapshotFeed) {
        const json = feeds.get(cam.snapshotFeed.base);
        out.push({
          id: cam.id,
          lastGoodFrameAt: json === undefined ? undefined : feedLastGood(json, cam.snapshotFeed.view),
        });
      }
    }
  }
  return out;
}
