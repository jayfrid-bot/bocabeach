/**
 * A tiny JPEG reader that returns only the average brightness of each 8x8
 * block of the picture (the DC coefficient of the luma component).
 *
 * WHY NOT A FULL DECODER: POST /ingest runs under the Workers free plan's
 * 10 ms CPU limit. A full decode (inverse DCT and colour conversion of 921,600
 * pixels) costs about 100 ms. This reader walks the Huffman data and throws
 * every AC coefficient away, which is the cheap part of the job. A 1280x720
 * frame becomes a 160x90 grid of block averages, which is all the "is this a
 * real picture" check needs (see frameQuality.ts).
 *
 * Scope: baseline and extended sequential JPEG (SOF0 / SOF1), 8 bit, with or
 * without restart markers. ffmpeg's mjpeg encoder and Chrome's screenshot
 * encoder both make this kind. A progressive JPEG (SOF2), arithmetic coding or
 * anything malformed returns null, and the caller must treat null as "could not
 * check", never as "bad picture".
 *
 * Pure byte parsing, no DOM or Worker APIs, so it is unit-testable in Node.
 */

export interface LumaGrid {
  /** Picture size in pixels, from the SOF segment. */
  width: number;
  height: number;
  /** Grid size in blocks. One block is 8x8 pixels of the luma plane. */
  cols: number;
  rows: number;
  /** cols * rows block averages, 0-255, row by row. */
  data: Uint8Array;
}

interface HuffTable {
  /** 9-bit lookahead: (length << 8) | symbol, or 0 when the code is longer than 9 bits. */
  fast: Uint16Array;
  /** Canonical-code data for codes longer than 9 bits. */
  maxcode: Int32Array; // index 1..17, -1 when no code of that length
  valptr: Int32Array;
  mincode: Int32Array;
  vals: Uint8Array;
}

const FAST_BITS = 9;

function buildHuffman(counts: Uint8Array, vals: Uint8Array): HuffTable {
  const fast = new Uint16Array(1 << FAST_BITS);
  const maxcode = new Int32Array(18).fill(-1);
  const valptr = new Int32Array(18);
  const mincode = new Int32Array(18);
  let code = 0;
  let k = 0;
  for (let len = 1; len <= 16; len++) {
    valptr[len] = k;
    mincode[len] = code;
    for (let i = 0; i < counts[len - 1]; i++) {
      if (len <= FAST_BITS) {
        const shift = FAST_BITS - len;
        const base = code << shift;
        for (let f = 0; f < 1 << shift; f++) fast[base + f] = (len << 8) | vals[k];
      }
      code++;
      k++;
    }
    maxcode[len] = counts[len - 1] > 0 ? code - 1 : -1;
    code <<= 1;
  }
  return { fast, maxcode, valptr, mincode, vals };
}

interface Component {
  id: number;
  h: number;
  v: number;
  tq: number;
  td: number;
  ta: number;
  pred: number;
}

export function readLumaDc(bytes: Uint8Array): LumaGrid | null {
  try {
    return readLumaDcUnsafe(bytes);
  } catch {
    return null; // truncated or corrupt: the caller treats this as "could not check"
  }
}

function readLumaDcUnsafe(bytes: Uint8Array): LumaGrid | null {
  const n = bytes.length;
  if (n < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;

  const qtables: (Uint16Array | undefined)[] = [];
  const dcTables: (HuffTable | undefined)[] = [];
  const acTables: (HuffTable | undefined)[] = [];
  let comps: Component[] = [];
  let width = 0;
  let height = 0;
  let restartInterval = 0;
  let pos = 2;

  // --- Segment pass: everything before the scan data. ---
  let scanStart = -1;
  while (pos + 3 < n) {
    if (bytes[pos] !== 0xff) {
      pos++;
      continue;
    }
    const marker = bytes[pos + 1];
    if (marker === 0xff) {
      pos++; // fill byte
      continue;
    }
    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      pos += 2;
      continue;
    }
    if (marker === 0xd9) return null; // EOI before any scan
    const len = (bytes[pos + 2] << 8) | bytes[pos + 3];
    if (len < 2 || pos + 2 + len > n) return null;
    const seg = pos + 4;
    const segEnd = pos + 2 + len;

    if (marker === 0xdb) {
      let p = seg;
      while (p < segEnd) {
        const pq = bytes[p] >> 4;
        const tq = bytes[p] & 15;
        p++;
        const table = new Uint16Array(64);
        for (let i = 0; i < 64; i++) {
          if (pq === 0) {
            table[i] = bytes[p++];
          } else {
            table[i] = (bytes[p] << 8) | bytes[p + 1];
            p += 2;
          }
        }
        if (tq < 4) qtables[tq] = table;
      }
    } else if (marker === 0xc4) {
      let p = seg;
      while (p + 17 <= segEnd) {
        const tc = bytes[p] >> 4;
        const th = bytes[p] & 15;
        p++;
        const counts = bytes.subarray(p, p + 16);
        p += 16;
        let total = 0;
        for (let i = 0; i < 16; i++) total += counts[i];
        if (p + total > segEnd) return null;
        const vals = bytes.subarray(p, p + total);
        p += total;
        const table = buildHuffman(counts, vals);
        if (th < 4) (tc === 0 ? dcTables : acTables)[th] = table;
      }
    } else if (marker === 0xdd) {
      restartInterval = (bytes[seg] << 8) | bytes[seg + 1];
    } else if (marker === 0xc0 || marker === 0xc1) {
      if (bytes[seg] !== 8) return null; // only 8-bit samples
      height = (bytes[seg + 1] << 8) | bytes[seg + 2];
      width = (bytes[seg + 3] << 8) | bytes[seg + 4];
      const nc = bytes[seg + 5];
      if (nc < 1 || nc > 4 || width < 1 || height < 1) return null;
      comps = [];
      for (let i = 0; i < nc; i++) {
        const o = seg + 6 + i * 3;
        comps.push({
          id: bytes[o],
          h: bytes[o + 1] >> 4,
          v: bytes[o + 1] & 15,
          tq: bytes[o + 2],
          td: 0,
          ta: 0,
          pred: 0,
        });
      }
    } else if (marker === 0xc2 || (marker >= 0xc3 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)) {
      return null; // progressive, lossless, arithmetic: not supported
    } else if (marker === 0xda) {
      const ns = bytes[seg];
      if (comps.length === 0 || ns !== comps.length) return null; // interleaved scans only
      for (let i = 0; i < ns; i++) {
        const cid = bytes[seg + 1 + i * 2];
        const tables = bytes[seg + 2 + i * 2];
        const comp = comps.find((c) => c.id === cid);
        if (!comp) return null;
        comp.td = tables >> 4;
        comp.ta = tables & 15;
      }
      scanStart = segEnd;
      break;
    }
    pos = segEnd;
  }
  if (scanStart < 0 || comps.length === 0) return null;

  // --- Geometry. ---
  let hmax = 1;
  let vmax = 1;
  for (const c of comps) {
    if (c.h < 1 || c.h > 4 || c.v < 1 || c.v > 4) return null;
    if (c.h > hmax) hmax = c.h;
    if (c.v > vmax) vmax = c.v;
  }
  const mcusX = Math.ceil(width / (8 * hmax));
  const mcusY = Math.ceil(height / (8 * vmax));
  const luma = comps[0];
  const lumaQ = qtables[luma.tq];
  if (!lumaQ) return null;
  const q0 = lumaQ[0];
  const gridCols = mcusX * luma.h;
  const gridRows = mcusY * luma.v;
  // Blocks that cover real pixels of the luma plane (the rest is padding).
  const cols = Math.min(gridCols, Math.ceil((width * luma.h) / (hmax * 8)));
  const rows = Math.min(gridRows, Math.ceil((height * luma.v) / (vmax * 8)));
  const data = new Uint8Array(cols * rows);

  for (const c of comps) {
    if (!dcTables[c.td] || !acTables[c.ta]) return null;
  }

  // --- Entropy-coded data. ---
  let bitBuf = 0;
  let bitCnt = 0;
  let p = scanStart;
  let hitMarker = false;
  let fakeBits = 0; // zero bits fed after the real data ended; consuming any means the file is cut short

  const fill = (): void => {
    while (bitCnt <= 24) {
      let b = 0;
      let fake = false;
      if (!hitMarker && p < n) {
        b = bytes[p];
        if (b === 0xff) {
          const next = p + 1 < n ? bytes[p + 1] : 0xd9;
          if (next === 0x00) {
            p += 2;
          } else {
            hitMarker = true; // RSTn or EOI: feed zeros until the caller realigns
            fake = true;
          }
        } else {
          p++;
        }
      } else {
        hitMarker = true;
        fake = true;
      }
      if (fake) fakeBits += 8;
      bitBuf = ((bitBuf << 8) | b) >>> 0;
      bitCnt += 8;
    }
  };

  const decodeHuff = (t: HuffTable): number => {
    if (bitCnt < 16) fill();
    const look = t.fast[(bitBuf >>> (bitCnt - FAST_BITS)) & ((1 << FAST_BITS) - 1)];
    if (look !== 0) {
      bitCnt -= look >> 8;
      return look & 0xff;
    }
    let code = (bitBuf >>> (bitCnt - FAST_BITS)) & ((1 << FAST_BITS) - 1);
    let len = FAST_BITS;
    while (len < 16) {
      len++;
      code = (bitBuf >>> (bitCnt - len)) & ((1 << len) - 1);
      if (t.maxcode[len] >= 0 && code <= t.maxcode[len] && code >= t.mincode[len]) {
        bitCnt -= len;
        return t.vals[t.valptr[len] + code - t.mincode[len]];
      }
    }
    throw new Error("bad huffman code");
  };

  const receive = (s: number): number => {
    if (s === 0) return 0;
    if (bitCnt < s) fill();
    bitCnt -= s;
    return (bitBuf >>> bitCnt) & ((1 << s) - 1);
  };

  const skipBits = (s: number): void => {
    if (bitCnt < s) fill();
    bitCnt -= s;
  };

  let mcuCount = 0;
  const totalMcus = mcusX * mcusY;
  for (let my = 0; my < mcusY; my++) {
    for (let mx = 0; mx < mcusX; mx++) {
      if (restartInterval > 0 && mcuCount > 0 && mcuCount % restartInterval === 0) {
        // Realign: drop the partial byte, find the RSTn marker, reset predictors.
        if (bitCnt < fakeBits) throw new Error("scan ended early");
        bitBuf = 0;
        bitCnt = 0;
        fakeBits = 0;
        hitMarker = false;
        while (p + 1 < n && !(bytes[p] === 0xff && bytes[p + 1] >= 0xd0 && bytes[p + 1] <= 0xd7)) p++;
        if (p + 1 >= n) throw new Error("missing restart marker");
        p += 2;
        for (const c of comps) c.pred = 0;
      }
      for (let ci = 0; ci < comps.length; ci++) {
        const c = comps[ci];
        const dc = dcTables[c.td] as HuffTable;
        const ac = acTables[c.ta] as HuffTable;
        for (let by = 0; by < c.v; by++) {
          for (let bx = 0; bx < c.h; bx++) {
            const s = decodeHuff(dc);
            if (s > 11) throw new Error("bad dc size");
            let diff = 0;
            if (s > 0) {
              const bits = receive(s);
              diff = bits < 1 << (s - 1) ? bits - (1 << s) + 1 : bits;
            }
            c.pred += diff;
            // AC coefficients: decode to advance the bit stream, keep nothing.
            let k = 1;
            while (k < 64) {
              const rs = decodeHuff(ac);
              const size = rs & 15;
              if (size === 0) {
                if (rs >> 4 === 15) {
                  k += 16;
                  continue;
                }
                break; // EOB
              }
              k += (rs >> 4) + 1;
              skipBits(size);
            }
            if (ci === 0) {
              const col = mx * c.h + bx;
              const row = my * c.v + by;
              if (col < cols && row < rows) {
                const v = Math.round((c.pred * q0) / 8 + 128);
                data[row * cols + col] = v < 0 ? 0 : v > 255 ? 255 : v;
              }
            }
          }
        }
      }
      mcuCount++;
    }
  }
  if (mcuCount !== totalMcus) return null;
  // A scan that ran past the real data decodes zeros: a mid-grey that would look
  // like a real picture. Refuse it: the stream must not have run dry early.
  if (bitCnt < fakeBits) return null;
  return { width, height, cols, rows, data };
}
