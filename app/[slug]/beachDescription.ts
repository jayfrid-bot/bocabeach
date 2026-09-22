import type { Location } from "@/lib/types";

// Oxford-comma join: ["a"] -> "a", ["a","b"] -> "a and b", ["a","b","c"] -> "a, b and c".
function joinList(items: string[]): string {
  if (items.length <= 1) return items.join("");
  if (items.length === 2) return items.join(" and ");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

// Coverage-aware: only claims what this beach's config actually has data for.
// Every beach gets the national data layers (score, weather, water temp,
// waves, tides, UV, wind); the local extras (seaweed/crowds from a cam,
// water quality, lifeguard flags) are mentioned only when configured — most
// beaches have no cams or water-quality site, so claiming them was false.
// Kept in its own module (not exported from page.tsx) since Next's typed
// routes only allow a fixed set of exports from a page file.
export function beachDescription(loc: Location): string {
  const topics = ["Beach Day score", "weather", "water temp", "waves", "tides", "UV", "wind"];
  if (loc.cams.length > 0) topics.push("seaweed", "crowds");
  if (loc.healthyBeaches) topics.push("water quality");
  if (loc.cityConditionsUrl || loc.flagsFeedUrl) topics.push("lifeguard flags");
  return `${loc.name} (${loc.region}): ${joinList(topics)}.`;
}
