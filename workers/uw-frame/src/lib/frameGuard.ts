/**
 * Pure "should this write replace the stored frame for a camera" decision,
 * shared by the POST /ingest handler (Mac courier uploads) and the
 * browser-grab path (src/index.ts) so both writers honor the exact same
 * rule and neither can silently clobber the other's newer good data.
 *
 * Rule: never replace a frame whose STORED meta is ok:true and whose
 * grabbedAtUtc is strictly newer than the candidate write's grabbedAtUtc.
 * Everything else — no stored meta yet, stored meta is ok:false, or the
 * candidate is the same age or newer — is allowed to write. This guards
 * against out-of-order writes (e.g. a slow browser-grab tick finishing
 * after a courier upload for a later timestamp has already landed, or vice
 * versa) without hard-coding a preference for either source by name.
 */

export interface StoredFrameMetaLike {
  readonly ok: boolean;
  readonly grabbedAtUtc: string;
}

export function shouldReplaceStoredFrame(
  stored: StoredFrameMetaLike | null | undefined,
  candidateGrabbedAtUtc: string
): boolean {
  if (!stored) return true;
  if (!stored.ok) return true;

  const storedMs = Date.parse(stored.grabbedAtUtc);
  const candidateMs = Date.parse(candidateGrabbedAtUtc);
  // If either timestamp fails to parse, fail open (allow the write) rather
  // than get stuck rejecting forever because of bad stored data.
  if (Number.isNaN(storedMs) || Number.isNaN(candidateMs)) return true;

  return candidateMs >= storedMs;
}
