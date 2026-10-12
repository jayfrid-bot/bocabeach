// One structured log line the first time a Clef read succeeds each UTC day (per
// Worker isolate). It is the canary that the AI binding accepts our request.
// Fields only: never the image, the Authorization header or the answers.

import { CLEF_MODEL, type ClefKind } from "@/lib/vision/clef";

let lastLoggedDay = "";

export function resetFirstSuccessLog(): void {
  lastLoggedDay = "";
}

export function logFirstSuccessOfDay(kind: ClefKind, latencyMs: number, inputTokens: number | null, nowMs: number = Date.now()): void {
  const day = new Date(nowMs).toISOString().slice(0, 10);
  if (day === lastLoggedDay) return;
  lastLoggedDay = day;
  console.log(JSON.stringify({ event: "clef-first-success", day, model: CLEF_MODEL, kind, latencyMs, inputTokens }));
}
