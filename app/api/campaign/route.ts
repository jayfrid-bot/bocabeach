import { getCloudflareContext } from "@opennextjs/cloudflare";
import { campaignForZip } from "@/lib/campaignBanner";

// GET /api/campaign → { show } for THIS visitor, from the ZIP code Cloudflare infers from the
// connection. Per visitor, so never cached anywhere (the edge cache and the service worker
// both skip it as an unlisted /api route). No location is stored or returned.
export async function GET() {
  let zip: string | undefined;
  try {
    const ctx = await getCloudflareContext({ async: true });
    zip = (ctx.cf as { postalCode?: string } | undefined)?.postalCode;
  } catch {
    zip = undefined;
  }
  return Response.json({ show: campaignForZip(zip, Date.now()) }, { headers: { "Cache-Control": "private, no-store" } });
}
