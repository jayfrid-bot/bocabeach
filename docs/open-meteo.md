# Open-Meteo: limits, fallback, and the paid plan

The app reads most of its weather from Open-Meteo: hourly and 7-day forecasts,
the rain nowcast, the GFS model, marine data, air quality (when AirNow has no
reading), GOES radiation, weather at each cam, and place search. Every call
goes through `lib/sources/openMeteo.ts`. The backend map is in
`docs/architecture.md` ("Open-Meteo client").

## What went wrong (2026-10-17)

The free API limits concurrent requests per IP. Cloudflare Workers share
outbound IPs with other customers. A cold build made about 8 Open-Meteo calls
at once, and Open-Meteo answered `429 Too many concurrent requests`. The page
then showed "Partial data: no UV index and sand temperature" and lost the
hourly chart and the 7-day outlook.

## What the app does now

1. **Fewer calls.** One build makes 2 calls to `/v1/forecast` for a beach,
   not 5: call A (hourly + daily) and call B (15-minute rain, current UV and
   cloud, and GFS through `models=best_match,gfs_seamless`). Both reproduce
   the old numbers exactly.
2. **Back-off.** A 429 is not retried. It pauses calls to that Open-Meteo host
   for about 60 s (45-75 s, or the `Retry-After` value if longer, at most
   5 min) in that Worker isolate. The Worker logs one line per pause:
   `[open-meteo] 429 from <host>; pausing calls to it for <n> s`.
3. **Last-good copy.** Every good answer is kept in isolate memory and in the
   Workers Cache API (`caches.default`, per datacenter). When a call fails, the
   app serves the copy if it is young enough: 3 h for hourly, 7-day, GFS,
   marine, air quality and satellite; 30 min for the nowcast; 1 h for cam
   weather. The source then shows status `stale`, the time Open-Meteo made the
   copy, and a note such as
   `live update failed (api.open-meteo.com -> 429: ...); showing the copy from 20 min ago`.
4. **Night UV.** After sunset the UV index reads 0 even with no forecast.

No new Cloudflare resource is needed. The Cache API needs no binding.

## Turn on the paid plan

1. Buy an Open-Meteo API plan and copy the key.
2. Store the key as a Worker secret (it is never in the repo or in a log):

   ```sh
   npx wrangler secret put OPEN_METEO_API_KEY
   ```

3. Deploy as usual. The next build uses the customer hosts
   (`customer-api.open-meteo.com`, `customer-marine-api.open-meteo.com`,
   `customer-air-quality-api.open-meteo.com`, `customer-satellite-api.open-meteo.com`,
   `customer-geocoding-api.open-meteo.com`) with `&apikey=<key>` on every call.

To check it: open `/api/conditions/<slug>` and read the `hourly` source. It
should be `"status": "ok"`. A wrong key gives a 4xx, so the sources go `stale`
for up to 3 h and then `error`, with the host and the status in the note (never
the key).

To turn it off: `npx wrangler secret delete OPEN_METEO_API_KEY`, then deploy.
The app goes back to the free hosts.

Local development reads the key from `.env.local` or the shell environment
(`OPEN_METEO_API_KEY=...`, see `.env.example`). Leave it unset to use the free API.

## Rules for code changes

- Call Open-Meteo only through `fetchOpenMeteoJson` or `openMeteoFetch`, and
  build URLs with `openMeteoUrl`. That keeps the pause, the key and the
  last-good copy in one place.
- Never add `current` or `minutely_15` to call A (`forecastPointUrl`). In the
  same request as `hourly`, they change the hourly numbers. A test checks this.
- Keep `best_match` first in call B's `models=`. Open-Meteo fills `current`
  from the first model listed.
- A note may name the host and the status. It must never contain the URL (the
  key is a query parameter).
