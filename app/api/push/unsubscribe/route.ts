// POST /api/push/unsubscribe — drop a stored subscription. Body: { endpoint }.

import { removeSubscription } from "@/lib/push/store";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  let endpoint = "";
  try {
    endpoint = ((await req.json()) as { endpoint?: string })?.endpoint ?? "";
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (typeof endpoint !== "string" || !endpoint) {
    return Response.json({ error: "missing endpoint" }, { status: 400 });
  }
  try {
    await removeSubscription(endpoint);
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
