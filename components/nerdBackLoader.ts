// The one place the "data nerd" back faces are imported from.
//
// lib/nerdInfo.ts (the long how-we-compute-this text for every card) is ~17 KB of
// script that nobody needs until they flip a card. It lives in its own chunk:
// the dashboard renders it through next/dynamic, and FlipCard calls `warmNerdBack`
// the moment a finger lands on (or a pointer hovers) a card, so by the time the
// tap finishes and the card starts to spin the chunk is already on its way.

// Only a warm-up: a failure here stays silent; the real load (next/dynamic in the dashboard)
// reloads the page once if the file is gone (lib/chunkReload.ts).
export const loadNerdBackFor = () => import("@/components/NerdBackFor");

let warmed = false;

/** Start fetching the back-face chunk. Safe to call from every card, any number of times. */
export function warmNerdBack(): void {
  if (warmed) return;
  warmed = true;
  loadNerdBackFor().catch(() => {
    warmed = false; // offline or a bad chunk: let the next intent try again
  });
}
