// /api/version — the currently-deployed build's git SHA. Polled by
// lib/useReloadOnNewVersion.ts so a phone that never re-launches the app (the
// iOS shell keeps the page alive in the background) still notices a new
// deploy and reloads itself, instead of running stale JS against fresh data.

import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return NextResponse.json(
    { sha: process.env.NEXT_PUBLIC_GIT_SHA ?? "" },
    { headers: { "Cache-Control": "no-store" } },
  );
}
