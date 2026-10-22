import { getCloudflareContext } from "@opennextjs/cloudflare";
import { campaignForZip } from "@/lib/campaignBanner";

// GET /api/campaign → { show } for THIS visitor, from the ZIP code Cloudflare infers from the
// connection. Per visitor, so never cached anywhere (the edge cache and the service worker
// both skip it as an unlisted /api route). No location is stored or returned.
export async function GET(req: Request) {
  let zip: string | undefined;
  let city: string | undefined;
  let source = "none";
  try {
    const ctx = await getCloudflareContext({ async: true });
    const cf = (ctx.cf ?? (req as unknown as { cf?: unknown }).cf) as { postalCode?: string; city?: string } | undefined;
    zip = cf?.postalCode;
    city = cf?.city;
    source = ctx.cf ? "context" : cf ? "request" : "none";
  } catch {
    zip = undefined;
  }
  const show = campaignForZip(zip, Date.now());
  // ?why=1 echoes the visitor's OWN inferred ZIP and city back to them, for checking the targeting.
  const why = new URL(req.url).searchParams.has("why");
  return Response.json(why ? { show, zip: zip ?? null, city: city ?? null, source } : { show }, {
    headers: { "Cache-Control": "private, no-store" },
  });
}
