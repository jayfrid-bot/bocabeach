// The `qrcode` npm package ships no types. We only use its dependency-free
// "core" encoder (matrix math only — no canvas/pngjs, so it works in the
// Workers/node runtime without pulling in a native binary or doing any I/O),
// via lib/qr.ts. This is a minimal ambient declaration for just that surface.
declare module "qrcode/lib/core/qrcode.js" {
  export interface QrBitMatrix {
    size: number;
    get(row: number, col: number): number;
  }
  export interface QrSymbol {
    modules: QrBitMatrix;
    version: number;
    errorCorrectionLevel: unknown;
  }
  export function create(
    data: string,
    options?: { errorCorrectionLevel?: "L" | "M" | "Q" | "H"; version?: number },
  ): QrSymbol;
}
