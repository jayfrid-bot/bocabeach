// Pure slug helpers for the resolver: turn a place name into a URL slug and
// disambiguate collisions against already-taken slugs (state suffix first, then
// numeric suffixes).

/**
 * Slugify a place name: lowercase, strip accents and punctuation, and collapse
 * runs of whitespace/dashes into a single dash. "Boca Raton" -> "boca-raton".
 */
export function toSlug(name: string): string {
  return name
    .normalize("NFKD")
    // drop combining accent marks (Unicode Mark category)
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    // anything that isn't a-z, 0-9, or whitespace/dash becomes a separator
    .replace(/[^a-z0-9\s-]+/g, " ")
    // collapse whitespace and dashes into a single dash
    .replace(/[\s-]+/g, "-")
    // trim leading/trailing dashes
    .replace(/^-+|-+$/g, "");
}

/**
 * Produce a slug for `name` that does not collide with anything in `taken`.
 * On collision, first try appending the (slugified) `state`; if that is also
 * taken — or no state is given — append "-2", "-3", … until unique. Comparison
 * is case-insensitive against `taken` (which is treated as already-slugged).
 */
export function uniqueSlug(name: string, taken: string[], state?: string): string {
  const used = new Set(taken.map((s) => s.toLowerCase()));
  const base = toSlug(name);
  if (!used.has(base)) return base;

  if (state) {
    const stateSlug = toSlug(state);
    if (stateSlug) {
      const withState = `${base}-${stateSlug}`;
      if (!used.has(withState)) return withState;
    }
  }

  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!used.has(candidate)) return candidate;
  }
}
