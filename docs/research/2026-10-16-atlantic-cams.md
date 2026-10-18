# Atlantic-coast live cams for the shore read and the sunrise check (research, 2026-10-16)

## Bottom line

I found 32 live cams on Florida's Atlantic coast that the app does not use yet. Fernandina Beach to Key West was swept. Nobody was contacted.

| Count | Number |
| --- | --- |
| Cams found and listed in the two main tables | 32 |
| Strong | 12 |
| Usable | 12 |
| Weak | 8 |
| Owned by a public body (city, county, special district, tourism board) | 19 |
| Owned by a business or a small operator | 13 |
| Already in the app (not counted above) | 11 cam entries at 3 beaches |

- **Best news: public bodies own 19 of the 32 cams.** The strongest are Martin County, the Jupiter Inlet District, the Sebastian Inlet District, Palm Beach County ERM and Volusia County Beach Safety. Four of those (Martin, Jupiter, Sebastian, Palm Beach) publish still images through the same host the app already reads for Boca Raton: `video-monitoring.com`. No new code is needed for them. Add a feed entry and the cam works.
- **Best YouTube picks:** Volusia County's four "Cam 180" fisheye streams (Ormond, Dunlawton, New Smyrna, Ponce Inlet), the Surf Station cam at north Vilano / south Ponte Vedra, the Best Western cam at Jacksonville Beach, and the Sombrero Beach cam in Marathon.
- **Best sunrise views** (east-facing, open horizon): Bathtub Beach and Jensen Beach (Martin County), Jupiter Inlet, Sebastian Inlet, the Surf Station Vilano cam. Jacksonville Beach and the Volusia fisheyes have a thin or curved sky strip.
- **Key West and Marathon face south.** They are good for water clarity and seaweed. They are not sunrise cams.
- **Nothing usable found** for Neptune Beach, Atlantic Beach, Cape Canaveral, Cocoa Beach, Melbourne Beach, Vero Beach, Fort Pierce, Miami Beach, Key Biscayne, Key Largo and Higgs/Smathers Beach. See "Not found". Many of those beaches have cams, but only on commercial networks (Surf Guru, Coastal Camera Network, Ozolio).
- **One bug to check in the app:** `config/locations.generated.json` puts `jacksonville-beach` at 30.390177, -81.394402. Jacksonville Beach Pier is near 30.294, -81.393. The pin is about 6.6 miles north (near Mayport). Fix it before a Jacksonville Beach cam is added.

## How this was done

- **YouTube search:** 25 `yt-dlp "ytsearch12:<place> live cam" --flat-playlist` searches, one per stretch of coast.
- **Owner pages:** I read tourism-board, city, county and park cam pages. Each lists the real owner and the embed. A YouTube id found on an owner's own page is a better lead than a search hit.
- **Liveness:** for 24 promising ids I fetched the watch page once and read `isLiveNow`, `isLiveDvrEnabled`, the channel and the description. This is one request per id. It is not yt-dlp.
- **Views:** for most ids I pulled the live thumbnail from `i.ytimg.com`. The thumbnail is a real frame unless the owner set a custom image (marked below). For 3 cams I grabbed one 720p frame with `yt-dlp -g` and `ffmpeg`. For the `video-monitoring.com` cams I downloaded today's stills.
- **Contacts:** every email below was read on the page named in the source. I listed a phone number or a form when no email was shown. I guessed nothing. One email on the Indian River County page was hidden by Cloudflare's email protection. I decoded it from the page's own data.
- **Facing** is an estimate from the frame and the map. It is good to about 30 degrees.
- **DVR** means YouTube's `isLiveDvrEnabled` flag was true. I did not measure the depth. The earlier sweep found 4 hours (about 2,880 segments) on most streams that had the flag. Check the depth with `yt-dlp -J` before you rely on it.

### Call budget

| Item | Count |
| --- | --- |
| yt-dlp calls (25 searches, 3 frame grabs) | 28 |
| Watch-page requests (one each, plain HTTP) | 24 |
| Total YouTube touches | 52 (limit 60) |
| Rate | one every 22 seconds or slower (under 3 per minute) |
| "Sign in to confirm you're not a bot" seen | never |

Sample frames and contact sheets are in `docs/research/2026-10-16-atlantic-cams/`.

## Already in use (skipped)

| Beach | Cams in the app | Source |
| --- | --- | --- |
| Boca Raton | 6 views: `boca-south`, `boca-south-surf`, `boca-inlet`, `boca-inlet-north`, `boca-inlet-surf`, `boca-inlet-jetty` | Palm Beach County ERM, hosted by `video-monitoring.com` |
| Deerfield Beach | `deerfield-beach-cam`, `deerfield-surf-cam`, `deerfield-pier-cam` (all three also in `config/sun-cams.json`), `deerfield-spinner-uw` | City of Deerfield Beach, YouTube |
| Fort Lauderdale | `ftl-elbo-beach-cam` (also in `config/sun-cams.json`; permission given if credited) | Elbo Room, YouTube |

The Gulf entries `fort-myers-beach` and `pensacola-beach` are out of scope. `config/locations.generated.json` also holds 36 beaches with no cams, among them `jacksonville-beach`, `daytona-beach`, `cocoa-beach` and `miami-beach`.

## Ask permission (businesses, non-profits and small operators)

Offer a credit line. The Elbo Room precedent is that a credit is the price. For YouTube cams the stream id changes when the owner restarts the stream, so ask for the channel's stable `/live` link.

| # | Beach (county) | Cam | Owner | Facing | Sand / water? | DVR | Stream link | Owner page | Contact (source) | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| B1 | Jacksonville Beach (Duval) | "Live Cam From The Best Western In Jacksonville Beach" | Best Western Oceanfront Jacksonville Beach hosts the camera. 911 Surf Report (founder Eddie Pitts) runs the stream. | E-NE, about 70 degrees. The pier is at the left edge. | y | y | https://www.youtube.com/watch?v=bZ4uxyLqV-E (live since 2025-01-22) | https://www.bestwesternjacksonvillebeach.com/ and https://911surfreport.com/live-beach-cams/ | 911 Surf Report: form at https://911surfreport.com/contact (no email shown; founder named at https://911surfreport.com/about-us/). Hotel: reservations@bwoceanfront.com, 904-249-4949 (https://www.bestwesternjacksonvillebeach.com/). | **strong.** The best shore frame of the sweep: sand, surf, swimmers, sharp horizon ([frame](2026-10-16-atlantic-cams/jax-beach-bw-oceanfront.jpg)). The sky strip is only about 8%, so sunrise is weak. The description says the cam is costly to run and has a tip link. |
| B2 | Jacksonville Beach (Duval) | Jacksonville Beach Pier: Overview, North View, South View | Three owners named in the stream text: The Jacksonville Beach Pier, Beach Life Rentals, 911 Surf Report | Overview looks along the pier to the E. North and South look along the beach. | y | y for Overview. North and South not probed. | https://www.youtube.com/watch?v=EOTLy91Ycew (Overview, live since 2026-07-25), https://www.youtube.com/watch?v=JLvCEDGJr-s (North), https://www.youtube.com/watch?v=c400PBf6adI (South) | https://911surfreport.com/jacksonville-beach-pier-overview-cam/ and https://jaxpiercam.com | jaxpiercam@gmail.com (https://jaxpiercam.com/contact/). Beach Life Rentals: beachliferentals@yahoo.com, (904) 372-0798, 503 1st St N (https://www.thejaxpier.com/). | **usable.** Pier view shows surf. North and South thumbnails show open beach in low light. B1 is the better shore cam. |
| B3 | North Vilano / South Ponte Vedra (St. Johns) | "North Vilano - South Ponte Vedra Surf Station Cam" | The Surf Station, a surf shop at 1020 Anastasia Blvd, St. Augustine Beach (owner Tory Strange). A "Jim's Surf House" mark sits in the frame: ask who hosts the camera. | E, about 90 degrees | y | **n** (flag false) | https://www.youtube.com/watch?v=o4BJ-eDgYrM (live since 2026-06-27) | https://www.surf-station.com/ | tory@surf-station.com (https://www.surfstationstore.com/pages/about-us). support@surf-station.com and (904) 471-9463 (https://www.surfstationstore.com/pages/contact-us). | **strong.** The best sunrise frame of the sweep: empty beach, surf, 45% clear sky, flat horizon ([frame](2026-10-16-atlantic-cams/vilano-surfstation.jpg)). No DVR, so the sun job must catch it live. |
| B4 | St. Augustine Beach (St. Johns) | "Surf Station North Pier Cam" | The Surf Station (also shown on 911surfreport.com) | E-SE, pier in frame (estimate from an old thumbnail) | y | y | https://www.youtube.com/watch?v=Q6eZVkUKFxo (live since 2022-02-27) | https://911surfreport.com/st-augustine-beach-pier-northside-cam/ | Same as B3 | **usable.** Confirmed live. The thumbnail is a 2023 branded image, so I did not see today's frame. |
| B5 | St. Augustine Beach (St. Johns) | "St. Augustine Beach Surf Cam" (10 blocks south of the pier) | The Surf Station | E, estimate | y | y | https://www.youtube.com/watch?v=H2q_DJc33kg (live since 2022-03-23) | https://911surfreport.com/st-augustine-beach-pier-southside-cam/ | Same as B3 | **usable.** Frame shows boardwalk, dunes and sea. A third cam, "3rd St" (https://www.youtube.com/watch?v=Lqr8XeVLMhI), was not probed. |
| B6 | Flagler Beach (Flagler) | "FlaglerA1A Pier LIVE" | "FlaglerA1A", an independent local site. No operator named. | E, street level | partial: the surf is a thin strip behind a crane and cars | y | https://www.youtube.com/watch?v=iv7n8iufcVM (live since 2025-08-26) | https://www.flaglera1a.com/ | flaglera1aconnect@gmail.com (https://www.flaglera1a.com/) | **weak.** The pier is under construction. Cars and a crane fill the frame. |
| B7 | Ormond-by-the-Sea (Volusia) | "Surf cam Ormond by the sea" | Surfers Warehouse (surf retailer) | E-SE, estimate | partial: lifeguard tower and rocks, ocean low in frame | y | https://www.youtube.com/watch?v=N4qsqCWw17w (live since 2026-10-03) | https://www.surferswarehouse.com/ | support@surferswarehouse.com (generic shop address, https://www.surferswarehouse.com/) | **weak.** The Volusia cams (P9, P13) cover the same beach better. |
| B8 | Jupiter (Palm Beach) | "Jupiter Reef Club Live Webcam" | Jupiter Reef Club (resort). The Town of Jupiter lists it as an area cam. | E-NE, about 60 degrees | y: a pool fills the foreground, with beach, sea and sky behind | n | https://www.youtube.com/watch?v=1FYgBpkM7SA (live since 2025-09-15) | https://www.jupiter.fl.us/2096/Jup-Life-Live-Cams | None found. `jupiterreefclub.com` shows a "domain may be for sale" notice. Try the Town of Jupiter, (561) 746-5134. | **usable.** Wide sky and horizon. No DVR. No contact found. |
| B9 | Key West, south shore (Monroe) | "Southernmost Beach Resort - Waterside" | Southernmost Beach Resort, 1319 Duval St. The channel "Seek Key West" streams it. The "omg" mark is Overseas Media Group, a producer. | S-SE, about 160 degrees | y: waves, sand, sargassum on the sand. No sky. | y | https://www.youtube.com/watch?v=UyfDBDRwPeI (this run began 2026-10-09). Channel: https://www.youtube.com/channel/UCL9JWWZ_e6D-cUNVP4mAtRw | https://www.southernmostbeachresort.com/webcams-2 | info@southernmostresorts.com and sales@southernmostresorts.com (https://www.southernmostbeachresort.com/contact-us). Phone 305.296.6577. | **strong for the shore read** ([frame](2026-10-16-atlantic-cams/key-west-southernmost-waterside.jpg)). Water color and seaweed are clear. Not a sunrise cam. |
| B10 | Key West, south shore (Monroe) | "Southernmost Beach Resort - Shores Pool" | Same as B9 | S-SE | y: pool in the foreground, beach and ocean beyond | y | https://www.youtube.com/watch?v=gsDDwA96F6Q | https://www.southernmostbeachresort.com/webcams-2 | Same as B9 | **usable.** |
| B11 | Key West, south shore (Monroe) | "Southernmost Beach Resort Buoy Cam" | Same as B9 | S | partial: beach cafe and the buoy, sea behind | unknown | https://www.youtube.com/watch?v=vvdy20Ho7ac (not probed) | https://www.southernmostbeachresort.com/webcams-2 | Same as B9 | **weak.** People and signs dominate. |
| B12 | Key West, Atlantic side (Monroe) | "La Trattoria Oceanside Cam" | La Trattoria (restaurants). The channel "Seek Florida Keys" streams it. | SE-S, about 140 degrees (estimate). It looks across S Roosevelt Blvd. | n: road, then water and sky | y | https://www.youtube.com/watch?v=Vs0eliTSu-A (live since 2025-01-24) | https://latrattoria.us/oceanside/ | No email shown. Oceanside 305.295.6789 (https://latrattoria.us/). | **weak.** Good sky, no sand. |
| B13 | Islamorada (Monroe) | "Lazy Days Islamorada" oceanfront cam | Lazy Days Islamorada (restaurant, MM 79.8) | SE-S. The stream zooms on Alligator Reef Lighthouse. | partial: small beach and water, deck in frame | y | https://www.youtube.com/watch?v=5pFDytRb4Qc (live since 2026-05-26) | https://www.lazydaysislamorada.com/ | dining@lazydaysislamorada.com, 305-664-5256 (https://www.lazydaysislamorada.com/) | **weak.** The pose changes with zoom. No steady shore view. |

## Public bodies (city, county, special district, state, tourism board)

Public owners are the easiest asks. Most list a phone and a form but not a cam-specific email. Four of the owners below (Martin, Jupiter, Sebastian, Palm Beach) publish stills through `video-monitoring.com` (Erdman Video Systems, `sales@video-monitoring.com` at https://video-monitoring.com/contact.php). The app already reads that host. Each view in a feed is a code such as `s2` or `c20`, and `latest.json` shows which views updated today. Some views are stale (for example, Jupiter `s8`, `s11` and `s16` were last updated in May).

| # | Beach (county) | Cam | Owner | Facing | Sand / water? | DVR | Stream link | Owner page | Contact (source) | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| P1 | Jupiter (Palm Beach) | Jupiter Inlet Webcam: NE, E, SE, S and lighthouse views | Jupiter Inlet District, a special district created by the Legislature in 1921 | N-NE to E. Views `s2`, `s32` and `s33` run along the beach and out to the sea. | y: beach, surf, open horizon | n/a: stills, plus a live stream on the page | https://video-monitoring.com/beachcams/jupiter/ (data: https://video-monitoring.com/beachcams/jupiter/latest.json) | https://www.jupiterinletdistrict.org/ | Joseph B. Chaison, P.E., Executive Director: jchaison@jupiterinletdistrict.org. Cami Cunningham, Assistant Director: ccunningham@jupiterinletdistrict.org. Phone (561) 746-2223. Source: https://www.jupiterinletdistrict.org/district-staff | **strong.** The page says "a service of the Jupiter Inlet District". Use views `s2` and `s32`-`s35`. `c20` is fogged. ([stills](2026-10-16-atlantic-cams/vm-jupiter-inlet-s2-ne.jpg)) |
| P2 | Jensen Beach (Martin) | Jensen Beach Webcam | Martin County (feed page: "a service of Martin County, FL") | N and S along the beach, ocean to the E | y: wide beach, surf, sky | n/a: stills | https://video-monitoring.com/beachcams/jensen/ | https://discovermartin.com/live-webcams/ and https://www.martin.fl.us/Coastal | Martin County Coastal Management, 2401 SE Monterey Rd, Stuart: (772) 288-5927. Form: https://www.martin.fl.us/contact-us. No email shown. Source: https://www.martin.fl.us/Coastal | **strong.** Views `s1` and `s5` are clean. `s3` was black today. ([stills](2026-10-16-atlantic-cams/vm-martin-county-stills.jpg)) |
| P3 | Stuart, Bathtub Beach (Martin) | Bathtub Beach Webcam | Martin County | E and NE. View `s11` looks straight out to the horizon. | y: surf, sand, sky | n/a: stills | https://video-monitoring.com/beachcams/bathtub/ | https://discovermartin.com/live-webcams/ | Same as P2 | **strong.** The best sunrise still of the sweep ([still](2026-10-16-atlantic-cams/vm-bathtub-beach-s11.jpg)). Views `s7` and `s17` show the car park only. |
| P4 | Hobe Sound (Martin) | Hobe Sound National Wildlife Refuge Beach Webcam | Martin County (the feed is the county's; the land is a federal refuge) | S along the beach (`s20`, `s21`, `s23`). `s24` looks W over the lagoon. | y | n/a: stills | https://video-monitoring.com/beachcams/hobesound/ | https://discovermartin.com/live-webcams/ | Same as P2 | **strong.** Quiet dune beach with sea and sky. |
| P5 | Sebastian Inlet (Indian River and Brevard) | Sebastian Inlet Webcam: North Jetty, Looking South, Surf and Jetty, South Jetty | Sebastian Inlet District | N, E and S views. `s18` and `s22` look out to the ocean. | y: beach, jetty, surf | n/a: stills | https://video-monitoring.com/beachcams/sebastian/ and https://sebastianinletcam.com | https://www.sitd.us/webcam-partially-operational-more-features-coming | Phone (321) 724-5175 (same page). No email shown. | **strong.** Clean beach views ([still](2026-10-16-atlantic-cams/vm-sebastian-inlet-s18.jpg)). The district's own notice says the cam runs in limited mode after jetty repairs. |
| P6 | Wabasso Beach (Indian River) | Wabasso Beach Cam | Indian River County (Natural Resources and Parks), built by the contractor Surf Guru Inc. | E (estimate) | y per the county text (surf and beach). I did not see a frame. | n | https://surfguru.com/embed/wabasso-beach-irc/ | https://www.indianriver.gov/services/natural_resources/coastal_engineering/beach-cam.php | Coastal@IndianRiver.gov (published on that page, hidden by Cloudflare). | **usable.** Two owners to ask: the county and Surf Guru. Not a YouTube stream. |
| P7 | Singer Island / Palm Beach Shores (Palm Beach) | Lake Worth Inlet Webcam | Palm Beach County Environmental Resources Management (ERM) | NE to E. Views `s4` and `s6` show the Singer Island beach. | y in 2 of 6 views | n/a: stills | https://video-monitoring.com/beachcams/lakeworthinlet/ | https://discover.pbc.gov/erm/Pages/Beach-Cams.aspx | erm-support@pbc.gov (Support Services, topics list "inlet/beach cams"). Phone 561-233-2400. Source: https://discover.pbc.gov/erm/Pages/Contact-Us.aspx | **usable.** A crane crosses two frames. This is the same owner as the Boca feeds. ([stills](2026-10-16-atlantic-cams/vm-jupiter-boynton-lakeworth-stills.jpg)) |
| P8 | Boynton Beach (Palm Beach) | Boynton Inlet Webcam | Palm Beach County ERM | Inlet and jetty views, E | partial: mostly jetty and channel | n/a: stills | https://video-monitoring.com/beachcams/boyntoninlet/ | https://discover.pbc.gov/erm/Pages/Beach-Cams.aspx | Same as P7 | **weak.** Inlet cam. Little sand. The page notes repairs finished 2026-09-18. |
| P9 | Ormond Beach (Volusia) | "Ormond Beach Cam 180" | Volusia County Beach Safety Division. The county page says WeatherBug maintains the cams. | N (the county page says north-facing, on the Ormond-by-the-Sea tower). The fisheye shows the beach and the sea to the E. | y | y | https://www.youtube.com/watch?v=p1s7EdZgGvU (live since 2026-08-14) | https://www.volusia.org/services/public-protection/beach-safety/beachcams-and-daily-safety-report.stml | Tamra Malphurs, Division Director: tmalphurs@volusia.gov. General: BeachSafety@volusia.gov. Phone 386-239-7873. Source: the owner page. | **strong.** Fisheye with beach, sea and sky ([sheet](2026-10-16-atlantic-cams/thumbs-2-volusia-cocoa-jupiter-pompano.jpg)). Ask WeatherBug too. |
| P10 | Dunlawton Beach, Port Orange / Daytona Beach Shores (Volusia) | "Dunlawton Beach Cam 180" | Volusia County Beach Safety | E, fisheye | y | y | https://www.youtube.com/watch?v=3hwTkO_5KXo (live since 2026-06-15) | Same as P9 | Same as P9 | **strong.** |
| P11 | New Smyrna Beach (Volusia) | "New Smyrna Beach Cam 180" (north side of the tower at Flagler Ave) | Volusia County Beach Safety | E, fisheye | y | **n** | https://www.youtube.com/watch?v=550p9smwjPM (live since 2026-07-10) | Same as P9 | Same as P9 | **strong** for the shore read. No DVR, so sunrise only if live. |
| P12 | Ponce Inlet (Volusia) | "Ponce Inlet Beach Cam 180" | Volusia County Beach Safety | E, fisheye | y: a pole crosses the frame | **n** | https://www.youtube.com/watch?v=ZCozdEGwkDI (live since 2026-07-10) | Same as P9 | Same as P9 | **usable.** |
| P13 | Ormond-by-the-Sea (Volusia) | "Ormond-By-The-Sea Beach Cam 180" | Volusia County Beach Safety | unknown | unknown: the thumbnail was black | unknown | https://www.youtube.com/watch?v=-grSyQa817o (not probed) | Same as P9 | Same as P9 | **weak** until checked. The county page embeds it. |
| P14 | Hollywood Beach (Broward) | "Live Beach Cam Hollywood Beach Broadwalk" (Johnson St, looking at the Hollywood Beach Theatre) | City of Hollywood | S along the Broadwalk, about 180 degrees | partial: the sea and sand sit at the edge. The Broadwalk is the subject. | y | https://www.youtube.com/watch?v=cmkAbDUEoyA (live since 2020-10-29) | https://www.hollywoodfl.org/1047/Hollywood-Beach-Webcams | citizenservices@hollywoodfl.org, 954-967-4357. No webcam-specific contact. Source: the owner page. | **usable.** Good for crowd. Weak for water clarity. The stream text carries a city disclaimer. The second stream, "Hollywood Beach Theatre" (`pcPwY5Qg594`), shows a stage only. |
| P15 | Dania Beach (Broward) | "Dania Beach Pier Cam" | City of Dania Beach | N along the beach (estimate) | y: pier, beach, surf, a weather bar | **n** | https://www.youtube.com/watch?v=o1eTLR7Degs (live since 2024-03-01) | https://www.daniabeachfl.gov/piercam | Nannette Rodriguez, Marketing and Communications Division Director, 954-924-6800 x3681. No email shown. Source: https://daniabeachfl.gov/Directory.aspx?did=110 (read in a search result, not opened). | **usable.** Clear shore view. Faces N, so not for sunrise. |
| P16 | Pompano Beach (Broward) | City beach, pier and inlet cams (player ids `copbfl1`, `copbfl2` on Brownrice) | City of Pompano Beach. The city's page marks every cam "currently out of service". | S (estimate) | y: a re-stream by "Florida Live" shows beach, tower and sea | y on the re-stream | https://player.brownrice.com/embed/copbfl2 and https://www.youtube.com/watch?v=zclpD3QKEK4 (re-stream by "Florida Live", live) | https://www.pompanobeachfl.gov/webcams and https://www.visitpompanobeach.com/webcams/ | Sandra King, Strategic Communications Administrator, 954.786.4527. Video specialist Christopher Gouveia, 954.786.4542. No emails shown. Source: https://www.pompanobeachfl.gov/government/strategic-communications | **weak.** The city says the cams are down. Ask when they return. |
| P17 | Lauderdale-By-The-Sea (Broward) | Town beach cam (beach pavilion, Anglin's Pier) and a west cam over Anglin's Square | Town of Lauderdale-By-The-Sea. EarthCam hosts the video. | E over the ocean (the EarthCam thumbnail shows a sunrise) | y | unknown | https://www.youtube.com/watch?v=tAdTOOsrZBQ (EarthCam's stream of the same cam) | https://www.discoverlbts.com/live-beach-webcam/ | Town main line 954-640-4200 (https://www.lauderdalebythesea-fl.gov/). Form: https://www.discoverlbts.com/contact-us/ | **usable.** Strong sunrise view, but two owners to ask: the Town and EarthCam. |
| P18 | Sunny Isles Beach (Miami-Dade) | "Live Beach Cams at the Newport Fishing Pier", North and South views | City of Sunny Isles Beach, Ocean Rescue Division | N and S along the beach | y per the city's text. I did not open the feed because the site blocks scripts. | unknown | Not found. A re-stream by "World Live Cams" shows the beach (https://www.youtube.com/watch?v=bi7B4EmyHHs). It may be another owner's cam. | https://www.sibfl.gov/Parks-Recreation/Beach/Beach-Cam-and-Conditions | Ocean Rescue 305.792.1940. City form: https://www.sibfl.gov/City-Hall/Contact-Us/Email-Us. No email shown. | **usable** on paper. Ask the city for the stream. |
| P19 | Marathon, Sombrero Beach (Monroe) | "Sombrero Beach Live WebCam" | Monroe County Tourist Development Council (the "Visit Florida Keys" site lists it as a TDC cam; channel "FloridaKeysTV"). The beach is a City of Marathon park. | S-SW, about 200 degrees | y: beach, palms, calm water | y | https://www.youtube.com/watch?v=jE4og3o_SXs (live since 2025-04-23) | https://visitfloridakeys.com/discover-the-keys/see-the-keys/webcams/marathon | webeditor@fla-keys.com (listed for groups that want to add TDC streams: https://visitfloridakeys.com/webcams/). 1-800-FLA-KEYS. | **strong** for the shore read. Not a sunrise cam. The sun rises left of the frame. |

## Commercial, needs a license

Do not dig into these. I list what each network holds on this coast so the owner knows which asks are blocked by a license. PTZtv has already refused us.

| Network | What it holds here | Evidence | Contact seen | Note |
| --- | --- | --- | --- | --- |
| Surf Guru Inc. | The Space Coast cams that Florida's Space Coast Office of Tourism pays for: Cocoa Beach (Best Western, Beach Shack, Hampton Inn), Jetty Park, Satellite Beach, Indialantic, Sebastian Inlet. Also Wabasso (county), Fort Pierce Inlet, Stuart Rocks, Palm Beach Shores, Jupiter Beach, Flagler Beach Pier, Dunlawton, Ponce Inlet, New Smyrna. | https://surfguru.com/surf-cams/ , https://www.visitspacecoast.com/surf-cams/ | Form: https://surfguru.com/contact/ (no email). Tourism office form: https://www.visitspacecoast.com/contact-us/ | Embeds are `surfguru.com/embed/<name>/`. They are not YouTube streams and have no DVR. This is the only source for Cocoa, Cape Canaveral, Melbourne Beach and Vero-area beaches. |
| Coastal Camera Network (also The Surfers View, HD Beach Cams) | Amelia Island: Seaside Amelia Inn (Main Beach), Ritz-Carlton, Omni Amelia Island Club. Daytona Beach: Hilton Daytona Beach Oceanfront. Key West: Casa Marina (2 cams), The Reach. YouTube streams: Amelia `daqQLF45EWQ`, Jacksonville pier `jo82nA0txwI`, Daytona `4L1hJ8Tur_A`, Cocoa `gAvFqhNwZm0`. | https://www.ameliaisland.com/island-views/ , https://www.daytonabeach.com/things-to-do/beaches/live-web-cam/ , https://casamarinaresort.com/live-webcam/ , https://www.seasideameliainn.com/beach-cam/ | Form: https://hdbeachcams.com/contact-us/ . Seaside Amelia Inn page shows jcox@innisfreehotels.com. | The hotel owns the view, the network owns the stream. Ask both. The Amelia cams are the only Fernandina Beach view found. |
| Ozolio, for the Greater Miami CVB | Miami Beach: 45th St (Eden Roc), 1st St (Hilton Bentley), 21st St, Sunny Isles North and South, Acqualina Sunny Isles, Virginia Key Beach Park. | https://www.miamiandbeaches.com/webcams , https://www.ozolio.com/explore/NZWC000018EE | Form: https://www.ozolio.com/contact/ (no email) | Only Miami Beach source found. I did not open the individual streams. |
| EarthCam | Anglin's Pier, Lauderdale-By-The-Sea (see P17). The Town of Jupiter also uses an EarthCam share link for its Riverwalk cam. | https://www.youtube.com/watch?v=tAdTOOsrZBQ | not sought | Needs a license. |
| Surfline | Juno Pier surf cam (the Town of Jupiter links it). | https://www.surfline.com/surf-report/juno-pier/5842041f4e65fad6a7708b78?camId=636a838491677c05bdc299db | not sought | Needs a license. |
| HDOnTap, Skyline Webcams | Not searched. | none | none | Listed as the brief asks. |
| PTZtv | Port Miami cam only (not a beach). | https://www.youtube.com/watch?v=DxZziUUr6CY | none | Already refused us. |
| Erdman Video Systems (`video-monitoring.com`) | Host for P1 to P5, P7, P8 and the Boca feeds the app uses. | https://video-monitoring.com/beachcams/ | sales@video-monitoring.com (https://video-monitoring.com/contact.php) | A host, not an owner. The owners above decide. A courtesy note may still help. |
| WeatherBug | Maintains the Volusia "Cam 180" cams. | https://www.volusia.org/services/public-protection/beach-safety/beachcams-and-daily-safety-report.stml | none | Ask with Volusia County. |
| Overseas Media Group ("omg", channels Seek Florida Keys and Seek Key West) | Produces the Southernmost and La Trattoria streams. Also the Sunset Grille cam from the Gulf sweep. | https://www.youtube.com/channel/UCL9JWWZ_e6D-cUNVP4mAtRw | `seekfloridakeys.com` is "launching soon" with a name-and-email form only | Not the owner of the view. Mention in the ask to Southernmost. |
| Re-streamers (not owners, do not ask) | World Live Cams, Florida Live, Beach Live Cams, Beaches Be Trippin, ZeroEight, Ozolio Live, Cam Nomad | n/a | n/a | Find the real owner instead. |

## Rejected

| Cam | Why |
| --- | --- |
| "Vilano Pier", See St. Augustine (`mYbn_umeenk`) | The frame shows a dock and a bridge on the Intracoastal side, not the ocean. Also "Vilano Boat Ramp" (`S8afSTXKkdw`). |
| SatelliteBeachLive (`6B3Dpn1TuNQ`) | Canal views, not the beach. |
| Juno Beach Pier cam, Loggerhead Marinelife Center (`5x4kaK_l3Aw`) | The id is a highlights video, not a live stream. The page says the underwater cam is down and the pier is closed for refurbishment since 2026-06-01. https://marinelife.org/juno-beach-pier-cam/ |
| Wahoo Bay underwater cam, City of Pompano Beach (`oBTGY6Ax870`) | Live, but underwater (turtles and fish). No sand or sky. |
| Pompano underwater pier cam (`mV8zVsX_o_0`) | The city lists it out of service. The thumbnail is black. |
| Hollywood Beach Theatre (`pcPwY5Qg594`) | Shows a stage. |
| Bahia Honda (`_RxQuhI8_TY`) | Faces the old bridge across a bay. No ocean beach. |
| Key West Bight, Fort Zachary Taylor, Cruise Port, Ocean Key | Harbor or Gulf side. The Gulf sweep covers them. |
| Key Largo cams on the Keys board (dolphin, harbor, Jewfish Creek) | Not beaches. |
| "I Love Cocoa Beach" (`hih53nffBRg`) | The watch page has no live flag. The stream has ended. |
| "Hutchinson Island Florida" (about 12 ids, for example `jMSvQoWeb0k`) | All show "was live". The county's Jensen Beach feed replaces them. |
| The Landmark Group, Flagler Beach (`23IzmTkU9rY`) | Ended. The thumbnail is a 2022 street view. |
| ZeroEight "South Beach Street Cam" (`Pd7tV_87GCE`) | A Collins Ave street cam, not the beach. |

## Not found

No live cam we could use was found for these. Where a commercial network covers the beach, it is named.

- **Atlantic Beach, Neptune Beach, Ponte Vedra Beach:** none, apart from B3 at south Ponte Vedra.
- **Fernandina Beach / Amelia Island:** only Coastal Camera Network cams. Sliders Seaside Grill lists a cam at https://www.slidersseaside.com/livebeachandbandcams but I could not find its stream.
- **Daytona Beach, Daytona Beach Shores:** Volusia's Dunlawton cam is nearby (P10). The Hilton cam is commercial.
- **Cape Canaveral, Cocoa Beach, Satellite Beach, Indialantic, Melbourne Beach:** Surf Guru only. The Cocoa Beach Pier site, cocoabeachpier.com, shows no cam.
- **Vero Beach (Humiston Park):** none. The county cam is at Wabasso (P6).
- **Fort Pierce:** Surf Guru lists "Fort Pierce Inlet". Not opened.
- **Juno Beach, Palm Beach:** Surfline only (Juno Pier). Discover The Palm Beaches lists a Singer Island cam, but its page blocked my request.
- **Lake Worth Beach:** the city has no cam page. The county inlet cam is P7.
- **Delray Beach:** the city's beach-conditions page says "check our beach cam". The page blocked my request and I found no stream. Ask the city's Ocean Rescue, (561) 27-BEACH is its public hotline.
- **Boynton Beach Oceanfront Park:** inlet cam only (P8).
- **Hillsboro Beach, Hallandale Beach, Bal Harbour, Surfside, Haulover:** none.
- **Fort Lauderdale (extra cams):** the city's Ocean Rescue page points to cams from the Greater Fort Lauderdale CVB at sunny.org. The page blocked my request. The Elbo Room cam is already in the app.
- **Miami Beach and Key Biscayne:** Ozolio cams only. No Crandon Park or Key Biscayne village cam found.
- **Key Largo, Islamorada:** no beach cam. B13 is a restaurant deck.
- **Higgs Beach, Smathers Beach (Key West):** none. B9 to B12 cover the south shore.
- **Delray, Pompano and Sunny Isles:** a city cam exists in each place, but I did not find a working stream link (see P16, P18 and the Delray note above).

## Suggested slugs and rough pins for the strong cams

The app has no entry for these beaches yet. Pins are rough and unchecked, as in the Gulf sweep. Check each pin on a map, then run the resolver in `lib/resolve/` for the tide station, buoy and NWS surf zone before you write an entry.

| Slug | Rough pin (lat, lon) | Zone | Cam that would serve it |
| --- | --- | --- | --- |
| `jupiter` | 26.945, -80.072 | America/New_York | P1, Jupiter Inlet District (video-monitoring feed `jupiter`) |
| `jensen-beach` | 27.254, -80.212 | America/New_York | P2 (feed `jensen`) |
| `stuart-bathtub-beach` | 27.20, -80.17 | America/New_York | P3 (feed `bathtub`). The pin is the least sure of the set. |
| `hobe-sound` | 27.08, -80.118 | America/New_York | P4 (feed `hobesound`) |
| `sebastian-inlet` | 27.859, -80.445 | America/New_York | P5 (feed `sebastian`) |
| `ormond-beach` | 29.36, -81.08 | America/New_York | P9 and P13. This is Ormond-by-the-Sea. The city of Ormond Beach is near 29.286, -81.056. |
| `dunlawton-beach` | 29.147, -80.967 | America/New_York | P10. It sits between `daytona-beach` (29.211, -81.023) and Ponce Inlet. |
| `new-smyrna-beach` | 29.024, -80.898 | America/New_York | P11 |
| `vilano-beach` | about 30.05, -81.32 | America/New_York | B3. The cam is south of Vilano and north of Ponte Vedra. This pin is a guess to check on a map. |
| `marathon` | 24.696, -81.108 | America/New_York | P19, Sombrero Beach |
| `key-west` | 24.546, -81.798 | America/New_York | B9. This is the south shore. The Gulf sweep used 24.560, -81.808 for a harbor cam, so keep one slug and attach both. |

Existing slug to fix: `jacksonville-beach` should be near 30.294, -81.393 for B1 and B2.

Usable-tier pins, if those asks succeed: `hollywood-beach` 26.0095, -80.1165; `dania-beach` 26.054, -80.112; `lauderdale-by-the-sea` 26.191, -80.096; `sunny-isles-beach` 25.940, -80.120; `singer-island` 26.780, -80.034; `wabasso-beach` 27.745, -80.385; `st-augustine-beach` 29.858, -81.268.

## Suggested order of asks

1. **Martin County, Jupiter Inlet District, Sebastian Inlet District, Palm Beach County ERM.** One short note each. No code change beyond a feed entry, because the host is the same as Boca. The Jupiter and Martin asks carry the best sunrise views.
2. **Volusia County Beach Safety** (Tamra Malphurs) with WeatherBug copied. Four YouTube streams in one ask.
3. **The Surf Station** (Tory Strange). One ask, up to three cams.
4. **911 Surf Report and the Best Western** at Jacksonville Beach.
5. **Southernmost Beach Resort** for a Key West south-shore view, and the **Monroe County TDC** for Sombrero Beach.
6. Hold the commercial networks until the rest is done.

## Gotchas for the next pass

- **YouTube ids change.** A restart gives a new id (Southernmost began again on 2026-10-09). Store the channel and ask for a stable `/live` link.
- **`video-monitoring.com` views drift.** A view can go stale or black. The app should check the `timedate` in `latest.json` and skip a view older than a day.
- **Thumbnails are not always live.** Some channels use a custom thumbnail (Surf Station St. Augustine cams, Hollywood, I Love Cocoa Beach). I marked the ones I judged from a thumbnail only.
- **Sky regions.** The Volusia fisheyes and the Jacksonville Beach cam have a thin or curved sky strip. Draw regions on a real frame, as the Gulf sweep did.
- **Bot check:** none seen. If it returns, stop all yt-dlp calls.

## What was added (2026-10-17, branch `cams-atlantic`)

The owner decided on 2026-10-16 to add every usable Florida cam now, with the owner credited and linked. If an owner objects, the cam comes down the same day (see "Taking a cam down").

**Beaches.** 17 new curated beaches, and `jacksonville-beach` moved from the auto-resolved pin (near Mayport) to the pier. Slugs: `jacksonville-beach`, `st-augustine-beach`, `vilano-beach`, `ormond-beach`, `dunlawton-beach`, `new-smyrna-beach`, `ponce-inlet`, `hollywood-beach`, `dania-beach`, `singer-island`, `jupiter`, `jensen-beach`, `stuart-bathtub-beach`, `hobe-sound`, `sebastian-inlet`, `wabasso-beach`, `key-west-south`, `sombrero-beach`. The Gulf branch holds `key-west` (Fort Zachary Taylor) and `marathon` (Sunset Grille). The Southernmost cams sit on `key-west-south`, on the Atlantic shore about 1 mi east of Fort Zachary Taylor. Sombrero Beach is a separate beach from the Gulf-side Marathon pin.

**Cams.** 27 cams with a still, plus one link-out. 15 are YouTube streams pulled by the home courier. 12 are `video-monitoring.com` stills (Jupiter Inlet District, Martin County, Sebastian Inlet District, Palm Beach County ERM), which need no YouTube pull. The Wabasso Beach cam is a link to Indian River County's own page: its embed allows only `indianriver.gov` to frame it.

**Pins.** Each pin is a public-access point from the FL Healthy Beaches feed or an OpenStreetMap place, moved about 50 m inland from the OSM coastline. The Vilano Beach, Ponce Inlet and Hollywood Beach pins and the two Keys pins are good to a few hundred metres. The Surf Station and Ponce Inlet cams carry no coordinates of their own because their exact spots are unconfirmed.

**Skipped, and why.**

| Cam | Why |
| --- | --- |
| P16, P17, P18 | Excluded by the owner: out of service, EarthCam-hosted, no stream found |
| B6, B7, B12 | Weak: crane and cars, a Volusia duplicate, no sand |
| B11, B13 | Weak: people and signs dominate, the pose changes with zoom |
| P8 Boynton Inlet | Weak: mostly jetty and channel |
| P13 Ormond-By-The-Sea (`-grSyQa817o`) | A live second Volusia cam at the same beach as P9. It adds no beach. It would cost one more pull an hour |
| B2 North and South views, B5 "3rd St" | Same beaches as B1 and B5. They would cost three more pulls an hour |
| Commercial networks | Surfline, EarthCam, HDOnTap, Skyline, Ozolio, Coastal Camera Network, PTZtv: excluded by the owner |

**YouTube load.** The 15 new streams add 15 `yt-dlp` pulls an hour (06:00 to 20:59 Eastern, 225 a day). Update (merge with the paced courier, 2026-10-17): the courier no longer keeps a cam list. `scripts/courier_schedule.py` builds it from config and paces every pull with the shared budget (`docs/courier-pacing.md`). The 14 new YouTube cams that are not sun cams have their video ids in `config/courier-cams.json`; `jax-beach-bw-cam` gets its id from `config/sun-cams.json`. The worker registry gives them the slowest cadence (`3h-daylight`). The sun-cam check adds about two `yt-dlp -J` calls a day for `jax-beach-bw-cam`, the only new sun cam. Of the new YouTube streams, only B1, B2, B4, B5, B9, B10, P9, P10, P14 and P19 keep a DVR; the other five cannot feed a sun cam.

**Owner to-dos.**

1. Install the courier change on the home server (the paced courier reads the new cams from config). Nothing was deployed or touched on the server.
2. Send the short courtesy notes. Each owner's contact is in the tables above.
3. Review `coastNormalDeg` and `coast` for the new beaches (left unset on purpose, as for the Gulf beaches).
4. Register sky regions for the other east-facing DVR cams (Ormond, Dunlawton, the Jacksonville Beach Pier) from a daytime frame.
5. Add the new beaches to the FamilyHub tablet list if wanted.

**Taking a cam down.** Set `archive: false` on the cam in `config/locations.ts` (it blocks archive ingest at once), then remove the cam from `config/locations.ts`, `config/vision-cams.json`, `config/archive-cams.json` (run `scripts/gen_archive_cams.ts`), `config/courier-cams.json` (or `config/sun-cams.json`) and the worker registry. Run `scripts/cam_archive_remove.ts` to erase stored frames.
