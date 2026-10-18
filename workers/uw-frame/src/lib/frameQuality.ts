/**
 * "Is this a real picture?" for a cam frame.
 *
 * Why it exists: on 2026-10-17 the worker was storing YouTube's loading spinner
 * (a black frame with the player's chrome) as a good frame, and the Mac courier
 * was uploading YouTube's black slate (the picture a live stream shows while it
 * is not sending video). Both looked like frames to every reader. A reader that
 * gets a black frame answers "no seaweed, empty beach", which is a false answer.
 *
 * The check reads the average brightness of each 8x8 block (see dcLuma.ts, cheap
 * enough for the free plan's 10 ms CPU limit) over the middle of the frame, and
 * calls the frame BLANK when the middle is a flat dark GREY with nothing brighter
 * in it. YouTube's slate, spinner and error pages are that grey (mean 17-21 of
 * 255). A real frame that is merely dark (a night shot, mean 0-15) is NOT blank:
 * black is darker than that grey. The thresholds live in config/frame-guard.json,
 * which scripts/cam_seaweed.py reads too.
 *
 * Fail open: a frame this code cannot decode is NOT called blank. Only positive
 * evidence of an empty frame rejects it.
 */
import { readLumaDc, type LumaGrid } from "./dcLuma";
import guardConfig from "../../../../config/frame-guard.json";

export const MIN_FRAME_BYTES: number = guardConfig.minBytes;
export const MAX_FRAME_BYTES: number = guardConfig.maxBytes;
export const RICH_FRAME_BYTES: number | null = guardConfig.richBytes;
export const BLANK_P95_BELOW: number = guardConfig.blankP95Below;
export const BLANK_MEAN_AT_LEAST: number = guardConfig.blankMeanAtLeast;
const REGION = guardConfig.region;

export type FrameRejection = "not-jpeg" | "too-small" | "too-large" | "blank";

export interface FrameStats {
  /** Blocks measured (the middle region of the 160x90 block grid). */
  blocks: number;
  mean: number;
  /** Brightness (0-255) that 95% of the measured blocks are at or below. */
  p95: number;
  p99: number;
  /** Share of measured blocks brighter than 40. */
  brightShare: number;
}

export interface FrameVerdict {
  ok: boolean;
  /** Set when ok is false. */
  reason?: FrameRejection;
  /** One plain sentence, fit for a log line or a JSON error. */
  message: string;
  /** False when the pixels were not read (rich frame, or a JPEG the reader cannot decode). */
  checked: boolean;
  stats?: FrameStats;
}

export function looksLikeJpeg(bytes: Uint8Array): boolean {
  return bytes.length > 2 && bytes[0] === 0xff && bytes[1] === 0xd8;
}

/** Statistics over the middle of the frame. Null when the region holds no blocks. */
export function regionStats(grid: LumaGrid): FrameStats | null {
  const r0 = Math.floor(grid.rows * REGION.top);
  const r1 = Math.ceil(grid.rows * REGION.bottom);
  const c0 = Math.floor(grid.cols * REGION.left);
  const c1 = Math.ceil(grid.cols * REGION.right);
  const hist = new Uint32Array(256);
  let blocks = 0;
  let sum = 0;
  for (let r = r0; r < r1; r++) {
    for (let c = c0; c < c1; c++) {
      const v = grid.data[r * grid.cols + c];
      hist[v]++;
      sum += v;
      blocks++;
    }
  }
  if (blocks === 0) return null;
  const at = (share: number): number => {
    const target = Math.ceil(blocks * share);
    let seen = 0;
    for (let v = 0; v < 256; v++) {
      seen += hist[v];
      if (seen >= target) return v;
    }
    return 255;
  };
  let bright = 0;
  for (let v = 41; v < 256; v++) bright += hist[v];
  return {
    blocks,
    mean: Math.round((sum / blocks) * 10) / 10,
    p95: at(0.95),
    p99: at(0.99),
    brightShare: Math.round((bright / blocks) * 1000) / 1000,
  };
}

export interface JudgeOptions {
  /** Override config richBytes (tests). null or Infinity always reads the pixels. */
  richBytes?: number | null;
}

/** Judge one frame: size and format first, then the pixels. Never throws. */
export function judgeFrame(bytes: Uint8Array, opts: JudgeOptions = {}): FrameVerdict {
  if (!looksLikeJpeg(bytes)) {
    return { ok: false, reason: "not-jpeg", checked: false, message: `not a JPEG (${bytes.length} bytes)` };
  }
  if (bytes.length < MIN_FRAME_BYTES) {
    return {
      ok: false,
      reason: "too-small",
      checked: false,
      message: `frame too small (${bytes.length} bytes; the least accepted is ${MIN_FRAME_BYTES})`,
    };
  }
  if (bytes.length > MAX_FRAME_BYTES) {
    return {
      ok: false,
      reason: "too-large",
      checked: false,
      message: `frame too large (${bytes.length} bytes; the most accepted is ${MAX_FRAME_BYTES})`,
    };
  }
  const rich = opts.richBytes !== undefined ? opts.richBytes : RICH_FRAME_BYTES;
  if (rich !== null && Number.isFinite(rich) && bytes.length >= rich) {
    return { ok: true, checked: false, message: "frame has full detail (not pixel-checked)" };
  }
  const grid = readLumaDc(bytes);
  const stats = grid ? regionStats(grid) : null;
  if (!stats) {
    return { ok: true, checked: false, message: "frame could not be pixel-checked; accepted" };
  }
  if (stats.p95 < BLANK_P95_BELOW && stats.mean >= BLANK_MEAN_AT_LEAST) {
    return {
      ok: false,
      reason: "blank",
      checked: true,
      stats,
      message:
        `blank frame: the picture is a flat dark grey, 95% of it darker than ${BLANK_P95_BELOW} of 255 ` +
        `(brightness p95 ${stats.p95}, mean ${stats.mean}) — YouTube's black slate, a player still loading, or an error page`,
    };
  }
  return { ok: true, checked: true, stats, message: "real picture" };
}
