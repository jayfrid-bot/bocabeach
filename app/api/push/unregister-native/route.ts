// POST /api/push/unregister-native — drop a stored native device token.
// Body: { token }.

import { removeNativeSub } from "@/lib/push/nativeStore";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  let token = "";
  try {
    token = ((await req.json()) as { token?: string })?.token ?? "";
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (typeof token !== "string" || !token) {
    return Response.json({ error: "missing token" }, { status: 400 });
  }
  try {
    await removeNativeSub(token);
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
