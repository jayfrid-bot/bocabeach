// The beach slugs the push tap handler opens without loading anything (config/beach-slugs.json, generated from
// config/locations.ts by scripts/gen_beach_slugs.ts). Tiny on purpose: it ships with the push handler.

import slugsJson from "@/config/beach-slugs.json";

export const KNOWN_BEACH_SLUGS: ReadonlySet<string> = new Set(slugsJson as string[]);
