# West-facing live cams for sunset truth (research, 2026-10-15)

## Bottom line

Every sun cam we had faced east. A sunset over the Atlantic is seen only as an afterglow ("antisolar"), so the sunset score has never been checked against a sky with the sun in it. A west-facing cam sees the sun go down in frame ("solar").

I swept the Florida Gulf coast, the Panhandle and the Keys on YouTube (2026-10-15) and probed about 45 live streams. I pulled today's real sunset from the 4-hour DVR of 18 of them. Four more face west but keep no DVR.

- **Two cams are public and are added.** Santa Rosa Island Authority "SRIA - West Cam" (Pensacola Beach) and Visit Fort Myers "Fort Myers Beach Live Webcam". Both run the full sun-cam pipeline today. A dry run on today's sunset scored them 75.1 (Pensacola) and 66.9 (Fort Myers Beach), view `solar`, 25 of 25 frames, coverage 10/8/7.
- **Twelve more cams have good west views but belong to businesses, media companies or re-streamers.** They need the owner's permission (the Elbo Room precedent: a credit line is the price). The best five to ask: Siesta Key, Anna Maria Island (White Sands Beach Resort), Panama City Beach (Sterling Reef), Key West (Cruise Port), Marathon (Sunset Grille).
- **Nothing usable was found** for Naples, Marco Island, Venice, Lido, St. Pete Beach, Treasure Island, Indian Rocks, Madeira, Clearwater Pier 60, Destin, Navarre, Cape San Blas, Mexico Beach, or a west-facing Atlantic exception. Details are under "Not found".

## How this was done

- Searched YouTube with `yt-dlp "ytsearchN:<beach> live cam" --flat-playlist`, then probed each live id with `yt-dlp -J` (channel, start date, formats, DVR depth).
- Grabbed one live frame per candidate (`yt-dlp -g` + `ffmpeg`), looked at each one, and kept those that could face west.
- At sunset, pulled 9 frames per cam from the DVR (-30 to +25 min around the cam's own sunset) with `DvrSession` from `scripts/sun_cam_check.py`. Strips of the -10, 0 and +10 minute frames are saved next to this file.
- Azimuth estimates come from where the sun sits in frame at -10 minutes (the sun's azimuth that evening was about 259 degrees) plus the map. They are good to about 15 degrees.
- Operator and terms come from the YouTube channel, the stream description, and the owner's own web page. Nobody was contacted.

**Gotcha for the next researcher.** About 150 `yt-dlp` calls in 15 minutes made YouTube answer "Sign in to confirm you're not a bot" for every video, from this Mac, for about 10 minutes. The Mac's address is the same one the home courier and the sun-cam job use, so those jobs may have missed a run in that window (17:00 to 17:12 ET). Pace probes to a few per minute. Also see the `android_vr` note in the memory file for the home server: without it, some streams expose only about 1 hour of DVR.

## Verdict table

Frame size is the stream's native size (all 1280x720 unless noted; the script reads the 720p HLS format). "DVR" means the 4-hour window the sun-cam job needs. Facing is the camera's centre bearing, estimated.

### Recommended (public body, added in this change)

| Beach | Cam, operator | Stream | Facing | Frame | 24/7 and DVR | Terms | Sample | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Pensacola Beach (Escambia Co.) | "SRIA - West Cam", Santa Rosa Island Authority (the public body that runs Pensacola Beach) | YouTube `HKIc6CYlMzI` (since 2025-04-23) | W, about 260 degrees. The sun sets over the end of the beach spit, in frame. Visit Pensacola's own page embeds this id and says "looking west". | 1080p source, fisheye | Yes, live 24/7; 2,880-segment DVR | Public authority; no published terms. Credit line used. A courtesy note to SRIA is advisable. | [strip](2026-10-15-west-facing-cams/sria-west.jpg), [full frame](2026-10-15-west-facing-cams/pensacola-sria-west-cam-sunset-m10-full.jpg), [regions](2026-10-15-west-facing-cams/pensacola-sria-west-cam-sky-regions.jpg) | **Recommended. Added.** Also a good shoreline cam (surf, foam, crowd on Casino Beach). Its "East Cam" (`890WmHX7h6U`) faces the other way and is not used. |
| Fort Myers Beach (Lee Co.) | "Fort Myers Beach Live Webcam", Visit Fort Myers (Lee County Visitor & Convention Bureau) | YouTube `nj9jdOXXhEo` (since 2026-09-03) | SW, about 225 degrees. The sun sets just past the right edge in October (the frame sees the sky and afterglow) and inside the frame near the winter solstice. | 720p | Stream is continuous; DVR 2,880 segments. Visit Fort Myers says most cams are live 6 AM to 11 PM ET and run a timelapse off-hours. Sunrise here is after 7 AM all year, so both events are live. | Public agency; its page shows only the bureau's copyright and no webcam terms. Credit line used. A courtesy note is advisable. Visitors can pan the cam from visitfortmyers.com. | [strip](2026-10-15-west-facing-cams/visitfm-fmb.jpg), [full frame](2026-10-15-west-facing-cams/fort-myers-beach-cam-sunset-p10-full.jpg), [regions](2026-10-15-west-facing-cams/fort-myers-beach-cam-sky-regions.jpg) | **Recommended. Added**, with two caveats: the sun is not always in frame, and the foreground is a beach construction site (the pier is being rebuilt, reopening late summer 2027). The view held still over about 3 hours of checks. If the bureau restarts the stream, the video id changes. |

### Needs permission (business, media company or re-streamer)

The view is good. Do not add until the owner has asked and has a credit line agreed.

| Beach | Cam, operator | Stream | Facing | Frame | 24/7 and DVR | Terms and permission | Sample | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Siesta Key | "SIESTA BEACH LIVE" (channel has no description; operator unknown) | YouTube `NLhxcyzXQxM` (since 2021-03-02) | W, about 260. Sun in frame at -10 min, behind dune palms. | 1080p | Yes, 2,880-segment DVR | Unknown owner. Find who runs it (Siesta Key Beach Resort or a condo) and ask. | [strip](2026-10-15-west-facing-cams/siesta-live.jpg) | Best Sarasota-area candidate: oldest stable id of the group. A second Siesta stream (`RpgDKeVx7Cw`) looks east over Little Sarasota Bay: not west. |
| Anna Maria Island | White Sands Beach Resort beach camera (channel "WHITESANDSFLORIDA") | YouTube `ecD9ZDXLE6A` (since 2026-08-05) | SW to W, about 230 (fisheye; sun sets at the right edge) | 720p | Yes, 2,880-segment DVR | Business cam; resort's own channel, so a polite ask with a credit line should work. | [strip](2026-10-15-west-facing-cams/whitesands-ami.jpg) | Excellent sky. Burned-in clock and logo along the top and bottom must be left out of the regions. Its second cam, "White Sands West North West" (`Gj26n68a2mI`), has no DVR (6 segments) and cannot feed the job. |
| Anna Maria Island (Holmes Beach) | "Anna Maria Island - Holmes Beach, FL", channel "Beach Live Cams" (a re-streaming channel) | YouTube `_W0Gf1Le2qc` (since 2026-08-11) | W, about 255. Sun centred at -10 min. | 1080p | Yes; DVR depth fine (no format 95; script falls back) | Aggregator: the true camera owner is not named. Rights unclear. | [strip](2026-10-15-west-facing-cams/beachlive-ami.jpg) | Prettiest sunset of all, but find the real owner before using it. |
| Fort Myers Beach | "License to Chill Live Beach Cam", Margaritaville Beach Resort Fort Myers Beach | YouTube `2qd9j2CbIpg` (since 2024-10-09) | WSW, about 255 | 1080p | Yes; no format 95 | Resort's own channel, posted as marketing. Ask for a credit. | [strip](2026-10-15-west-facing-cams/margaritaville-lic.jpg) | Huge sky, sunset in frame. Logo top left and weather widget top right are overlays: leave them out. A second public-body cam already covers this beach, so this is a backup. |
| Fort Myers Beach | Pink Shell Resort cam, re-streamed by "Florida Live" (resort page: pinkshell.com/live-webcams) | YouTube `uK-eZz0w-go` (since 2026-04-24) | W, about 260. Sun sets behind palms. | 1080p | Yes, 2,880-segment DVR | Re-streamer; the resort is the owner. | [strip](2026-10-15-west-facing-cams/pinkshell.jpg) | Palms and a pool fill most of the frame. Weaker than the two above. |
| Panama City Beach | "Sterling Reef" beach cam, ENCO Electronic Systems (an engineering firm that runs a network of resort beach cams) | YouTube `Y82E6_IVEdY` (since 2024-11-20) | WSW, about 240. Sun and the pier in frame. | 1080p | Yes, 2,880-segment DVR | Business. ENCO runs a "Beachcam" newsletter, so it is used to public viewing. Ask. | [strip](2026-10-15-west-facing-cams/enco-sterlingreef.jpg) | Cleanest sky strip of the Panhandle set. Another ENCO cam, "Shores of Panama" (`GFsRPlw81W8`, about 230, sun at the right edge), also works; [strip](2026-10-15-west-facing-cams/enco-shoresofpanama.jpg). Panhandle beaches face south, so the sun sets along the beach, not out to sea. |
| Panama City Beach | "Schooners" beach bar, Beach TV (a media company) | YouTube `pzWkmPxhW6I` (since 2026-10-11) | WSW, about 245 | 720p | Yes, but the id is 4 days old: this venue restarts its stream often | Business and media. | [strip](2026-10-15-west-facing-cams/beachtv-schooners.jpg) | Crowd and stage fill the frame. Poor for the sky regions. |
| Panama City Beach | "Sharky's Beachfront Restaurant", re-streamed by "Florida Live" | YouTube `EYs8y8gOwf0` (since 2026-06-22) | WSW, about 245 | 1080p | Yes | Re-streamer; Sharky's is the owner. | [strip](2026-10-15-west-facing-cams/sharkys-pcb.jpg) | A thatch roof takes the right edge. |
| Key West | "Cruise Port Key West", BLC Streams (Subsurface Media) | YouTube `8Rw-tZTeBjU` (since 2025-06-11, 230 viewers) | WSW, about 235. Sunset over the harbour, in frame. | 1080p | Yes, 2,880-segment DVR | The description says content is rights managed and may not be copied without permission. Must ask. | [strip](2026-10-15-west-facing-cams/kw-cruiseport.jpg) | Best Keys view and a real Gulf sunset. Worth the email. |
| Key West | Fort Zachary Taylor Beach, re-streamed by "Florida Live" | YouTube `sDXwrYQPeOQ` | WSW, about 240 | 1080p | Yes, but only about 3.5 hours of DVR (2,533 segments) | Re-streamer; real owner unknown (state park?). | [strip](2026-10-15-west-facing-cams/kw-fortzach.jpg) | Sky in the top 20% only. |
| Marathon | Sunset Grille and Raw Bar, "Seek Florida Keys" (made by Overseas Media Group) | YouTube `SXMC-MzSncI` (since 2025-10-21) | W, about 260. Sun sets in frame beside the Seven Mile Bridge. | 1080p | Yes, 2,880-segment DVR | Restaurant. Logo and "omg" mark are overlays. Ask. | [strip](2026-10-15-west-facing-cams/marathon-sunsetgrille.jpg) | Good. Palms cross the sky, so the regions need care. |

### Rejected

| Beach | Cam | Why |
| --- | --- | --- |
| Sanibel | Sanibel Lighthouse Beach, Visit Fort Myers (`ZtrNffrXPdw`), public | Faces the lighthouse and the island scrub: no open water or horizon. [Frame](2026-10-15-west-facing-cams/sanibel-lighthouse-1700et.jpg). |
| Sanibel | EarthCam "Sanibel Island" at Shalimar Beach Resort (`4LTSTw4jnZc`) | Faces away from the sunset: no sun, little sky. EarthCam also reserves its content. [Strip](2026-10-15-west-facing-cams/earthcam-sanibel.jpg). |
| Pine Island (Bokeelia) | Cape Weather "Sunset and Sunrise PTZ Cam" (`1yGtTaJ33jY`) | Faces west over Pine Island Sound, a lovely sky, but the stream keeps no DVR (6 segments), so the job cannot rebuild an event. It is a private hobby cam over a sound, not the Gulf. [Frame](2026-10-15-west-facing-cams/bokeelia-1700et.jpg). |
| Miramar Beach / Destin | ENCO "Whales Tail" (`TyX02EtQcYI`), ENCO "Leeward Key" (`CVgBM39TOh8`), Destin beach cams (`2i12Vv2iWWs`, Ocean Reef) | Panhandle beach faces south. The frames show sun glare to the west but no DVR (Whales Tail) or only a tight water view. [Frame](2026-10-15-west-facing-cams/enco-whalestail-1700et.jpg). |
| Panama City Beach | "Laguna Beach Christian Retreat" (`nT8aBQx8OS4`) | Faces south-east; the sunset is out of frame. [Strip](2026-10-15-west-facing-cams/laguna-pcb.jpg). |
| Clearwater Beach | Jimmy's on the Edge / The Edge Hotel ("Clearwater Beach Live Cams") | Face north over a pool and buildings. Sunset out of frame. [Strip](2026-10-15-west-facing-cams/clw-onedge.jpg). Jimmy's Fish House (`emDyfhDmfUk`) looks west but keeps no DVR (6 segments). [Frame](2026-10-15-west-facing-cams/clw-fishhouse-1700et.jpg). |
| Marathon | Sombrero Beach, FloridaKeysTV (`jE4og3o_SXs`) | Faces south-south-west, about 215. The sun sets beyond the right edge; only a pink afterglow is in frame. Atlantic side, not a west exception. [Strip](2026-10-15-west-facing-cams/marathon-sombrero.jpg). |
| Pensacola Beach | SRIA "East Cam" (`890WmHX7h6U`) | Faces east. Not used. |
| Naples | Naples Beach Hotel and Golf Club beach cam | All 8 listed streams have ended. No live stream today. |
| Naples | Naples Pier | The pier is being rebuilt. The only live "Naples Pier" hits were old news clips. |

### Not found

Searches on 2026-10-15 turned up no 24/7 YouTube cam, or no public stream we could use, for: Naples, Marco Island, Venice (only an Intracoastal dock cam at Nokomis), Lido Key and Sarasota, Bradenton Beach, St. Pete Beach (one id returned no data), Treasure Island, Indian Rocks, Madeira Beach (a marina dock cam at John's Pass, facing the dock), Clearwater Pier 60 (cams exist on hdontap and Skyline Webcams, which are commercial pages, not streams we may use), Destin, Navarre, Cape San Blas, Mexico Beach, Cedar Key, Boca Grande, and any west-facing Atlantic beach in Florida. A few ids (`Qoouv_9QG5Q` Perdido Key, `I4H1dQFnfR0` Perdido Key OG, `htpZ21xtzhM` Ocean Key Sunset Pier, Key West) could not be probed because of the bot check; a later pass could try them.

YouTube coverage dates Hurricane Isaias on the Panhandle at 9 to 10 October. Cams there may have moved or been repaired since.

## What was added

The two recommended cams, end to end. See the change list in the commit (not committed yet).

- `config/locations.ts`: curated beaches `fort-myers-beach` and `pensacola-beach`, each with its cam. They must be curated entries, not `locations.generated.json` entries, because the vision registry and the archive manifest read only the curated list.
- `config/sun-cams.json`: both cams, with `"facing": "west"`, `facing_azimuth_deg` 225 (Fort Myers Beach) and 260 (Pensacola), credit lines, and sky regions drawn on the real 2026-10-15 sunset frames.
- `config/vision-cams.json`: both cams, role `shore`, each with a vision hint.
- Generated: `config/archive-cams.json`, `config/beach-slugs.json`, `ios/App/WatchShared/Beaches.json`, and one line in `config/nwpsRip.ts` for Pensacola Beach (Fort Myers Beach has no NWPS rip-model coverage).
- Courier and worker: `scripts/cam_courier_local.sh`, `workers/uw-frame/src/lib/schedule.ts`, `scripts/golden_now.py`, and the golden launchd job (hour 21 added: Pensacola's summer sunset window reaches 21:14 Eastern).

## Beaches to add if permission comes

Coordinates and surf-zone block names are rough and unchecked. Before an entry is written, check the pin on a map and run the resolver in `lib/resolve/` (see how `scripts/` calls `resolveBeach`) for the nearest tide station, buoy and NWS surf zone.

| Slug | Pin (lat, lon) | Zone | NWS surf zone (office, block) | Cam that would serve it |
| --- | --- | --- | --- | --- |
| `siesta-key` | 27.266, -82.553 | America/New_York | TBW, Coastal Sarasota | Siesta Beach Live |
| `anna-maria-island` | 27.50, -82.72 | America/New_York | TBW, Coastal Manatee | White Sands Beach Resort |
| `panama-city-beach` | 30.177, -85.806 | America/Chicago | TAE, Coastal Bay | Sterling Reef, Shores of Panama |
| `key-west` | 24.560, -81.808 | America/New_York | KEY | Cruise Port Key West |
| `marathon` | 24.70, -81.12 | America/New_York | KEY | Sunset Grille |

## Owner follow-ups

1. Send a short courtesy note to the Santa Rosa Island Authority and to Visit Fort Myers (credit lines are in the registry).
2. Ask permission, offering the credit line, from the five best business cams above.
3. Review `coastNormalDeg` and `coast` for the two new beaches (the map says about 235 for Fort Myers Beach and about 180 for Pensacola Beach). They were left unset on purpose.
4. Deploy: the uw-frame worker, then update the courier script and the golden launchd job on the home server (`ssh server`), then the app. Pull this branch on the server and run `launchctl bootout` then `bootstrap` for the golden plist.
5. Update the FamilyHub tablet's beach list: add `{"slug": "fort-myers-beach", "name": "Fort Myers Beach", "state": "FL"}` and `{"slug": "pensacola-beach", "name": "Pensacola Beach", "state": "FL"}` to `app/src/main/assets/beaches.json` (sorted by state, then name; today's file is in the `FamilyHub-wt-beach-board` worktree on branch `beach-card`). Not touched here.
