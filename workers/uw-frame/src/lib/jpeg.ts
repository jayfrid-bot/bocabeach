/**
 * Minimal, dependency-free JPEG dimension reader.
 *
 * Needed so POST /ingest can write the legacy `frame:meta` shape
 * ({grabbedAtUtc, bytes, width, height}) with REAL dimensions for whatever
 * the Mac courier's ffmpeg happened to encode (its `best[height<=720]`
 * format selector doesn't guarantee the worker's own fixed 1280x720
 * viewport size), rather than just assuming the browser-grab path's
 * VIEWPORT constant. Pure byte-parsing, no DOM/Worker APIs, so it's
 * trivially unit-testable.
 *
 * Walks JPEG markers from the SOI (0xFFD8) looking for a Start-Of-Frame
 * marker (0xFFC0-0xFFCF, excluding the DHT/JPG-extension markers 0xC4/0xC8/
 * 0xCC which share the numeric range but aren't SOF markers) and reads the
 * big-endian height/width out of its segment.
 */
export function readJpegDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null; // not a JPEG (no SOI)

  let offset = 2;
  while (offset + 1 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset++; // resync on stray bytes
      continue;
    }
    // Skip fill bytes (0xFF repeated before the real marker byte).
    let marker = bytes[offset + 1];
    let markerOffset = offset + 1;
    while (marker === 0xff && markerOffset + 1 < bytes.length) {
      markerOffset++;
      marker = bytes[markerOffset];
    }

    // Markers with no length/payload that follow immediately.
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      offset = markerOffset + 1;
      continue;
    }

    const segStart = markerOffset + 1;
    if (segStart + 1 >= bytes.length) return null; // truncated
    const segLen = (bytes[segStart] << 8) | bytes[segStart + 1];
    if (segLen < 2) return null; // malformed

    const isSOF = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSOF) {
      if (segStart + 6 >= bytes.length) return null; // truncated SOF segment
      const height = (bytes[segStart + 3] << 8) | bytes[segStart + 4];
      const width = (bytes[segStart + 5] << 8) | bytes[segStart + 6];
      if (width > 0 && height > 0) return { width, height };
      return null;
    }

    if (marker === 0xda) return null; // start-of-scan reached with no SOF seen — give up

    offset = segStart + segLen;
  }

  return null;
}
