// QR code module matrix, computed with zero I/O and zero native deps.
//
// The `qrcode` package's top-level API (toDataURL/toBuffer/toString) renders
// through canvas/pngjs, which the ImageResponse route can't use (no external
// fetches, no extra native binaries in the Workers bundle — see
// app/opengraph-image.tsx's constraints). Its "core" encoder underneath has
// none of that: it just does the Reed-Solomon/matrix math and hands back a
// size x size bitmap, which we render as satori-safe <div> squares in
// app/api/share/[slug]/route.tsx instead of an <img>/<svg>.
import { create as createQrSymbol } from "qrcode/lib/core/qrcode.js";

export interface QrMatrix {
  size: number;
  isDark(row: number, col: number): boolean;
}

/** Computes the module matrix for `text`. Throws only if `text` is empty —
 *  callers should guard with a non-empty share URL, which is always the case
 *  here (built from a known slug). */
export function qrMatrix(text: string, errorCorrectionLevel: "L" | "M" | "Q" | "H" = "M"): QrMatrix {
  const symbol = createQrSymbol(text, { errorCorrectionLevel });
  const { modules } = symbol;
  return {
    size: modules.size,
    isDark: (row: number, col: number) => modules.get(row, col) === 1,
  };
}
