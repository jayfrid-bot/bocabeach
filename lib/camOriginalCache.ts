// The Workers Cache API store for full-size cam originals (/api/cam/[id]?res=hr).
//
// Why: an original is 1.5 to 7 MB and comes from a county server that drops request bursts.
// A Worker response is NOT cached at the edge by a Cache-Control header, and Next's own
// fetch cache refuses bodies over 2 MB, so without this every zoom would hit the county.
//
// The key is the RESOLVED upstream URL. The original's file name changes with every
// capture ("o181403h.jpg"), so one key is one picture and never goes stale: a new
// capture is a new key. The entry lives 10 minutes (a feed view refreshes every 10 to 30).
//
// Where `caches` does not exist (Node, tests, next dev) a read is a miss and a write does
// nothing. Workers Cache only stores on a custom domain; the site is on one.

export const ORIGINAL_TTL_SEC = 600;
const KEY_PREFIX = "https://cache.isitbeachday.internal/camoriginal/";

interface CacheLike {
  match(key: string): Promise<Response | undefined>;
  put(key: string, res: Response): Promise<void>;
}

function defaultCache(): CacheLike | null {
  try {
    const d = (globalThis as { caches?: { default?: CacheLike } }).caches?.default;
    return d && typeof d.match === "function" && typeof d.put === "function" ? d : null;
  } catch {
    return null;
  }
}

export const originalCacheKey = (resolvedUrl: string): string => `${KEY_PREFIX}${encodeURIComponent(resolvedUrl)}`;

/** The stored original for this resolved URL, or undefined. Never throws. */
export async function readOriginal(resolvedUrl: string): Promise<Response | undefined> {
  try {
    return (await defaultCache()?.match(originalCacheKey(resolvedUrl))) ?? undefined;
  } catch {
    return undefined;
  }
}

/** Store the original for ORIGINAL_TTL_SEC. Returns the promise so the caller can hand it to waitUntil. Never throws. */
export async function storeOriginal(
  resolvedUrl: string,
  bytes: ArrayBuffer,
  contentType: string,
  size?: string | null,
): Promise<void> {
  try {
    await defaultCache()?.put(
      originalCacheKey(resolvedUrl),
      new Response(bytes, {
        headers: {
          "Content-Type": contentType,
          "Cache-Control": `public, max-age=${ORIGINAL_TTL_SEC}`,
          ...(size ? { "X-Cam-Original-Size": size } : {}),
        },
      }),
    );
  } catch {
    /* a cache that fails is a cache that misses */
  }
}
