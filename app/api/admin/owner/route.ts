// Marks this browser as the owner's so its sticker scans are not counted.
// The owner console (/admin/yf) calls this on load. The cookie is set by the
// server (Set-Cookie), not by page script: Safari caps script-set cookies at
// 7 days, but keeps a first-party server-set cookie for its full lifetime.

import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const OWNER_COOKIE = "ibd_owner";
const TWO_YEARS_S = 60 * 60 * 24 * 730;

export async function GET(): Promise<Response> {
  const res = NextResponse.json({ ok: true, excluded: true });
  res.cookies.set(OWNER_COOKIE, "1", {
    path: "/",
    maxAge: TWO_YEARS_S,
    httpOnly: true,
    secure: true,
    sameSite: "lax",
  });
  return res;
}
