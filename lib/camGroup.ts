// Which capture group of a cam feed (cam_seaweed.<slug>.json) a SEAWEED or WATER
// reader should use. scripts/cam_seaweed.py publishes three groups:
//   latest       the newest capture. At low sun (dusk, dawn) its cams publish no
//                seaweed or water, but its crowd counts are still good.
//   lastSeaweed  today's newest capture with at least one published seaweed level.
//   morning      today's earliest complete morning capture.
// Crowd readers (busyness) keep using `latest`. Seaweed and water readers call
// this, so one rule decides which group they show: the newest group that has a
// usable reading. The chosen group keeps its own `capturedAtLocal`, so the card
// says honestly when it was read. Pure.

export type CamGroupSource = "latest" | "lastSeaweed" | "morning";

interface GroupLike {
  capturedAtLocal?: string;
  cams?: unknown[];
}

export interface CamGroupFeed<G extends GroupLike> {
  latest?: G | null;
  lastSeaweed?: G | null;
  morning?: G | null;
}

/** The first of latest, lastSeaweed, morning that `hasReading` accepts, with its
 *  source; null when none does. `hasReading` tests one group for what the caller
 *  needs (a seaweed level, a water grade). */
export function pickCamGroup<G extends GroupLike>(
  feed: CamGroupFeed<G> | null | undefined,
  hasReading: (group: G) => boolean,
): { group: G; source: CamGroupSource } | null {
  for (const source of ["latest", "lastSeaweed", "morning"] as const) {
    const group = feed?.[source];
    if (group && hasReading(group)) return { group, source };
  }
  return null;
}
