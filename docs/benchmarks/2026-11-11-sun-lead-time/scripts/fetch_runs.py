# Rebuild what the hourly forecast said for each graded sun event from two
# earlier model runs, with Open-Meteo's Single Runs API (public, read-only; the
# app's own hourly feed is Open-Meteo "best match", which for Florida is
# gfs_seamless = HRRR + GFS). The live archive holds almost no sunset forecast
# made 1-6 h ahead (the archiver's daily budget ran out before sunset until
# 2026-11-05), so this is the only way to grade a short-lead sunset forecast.
#
#   python3 fetch_runs.py <repo> <raw dir>
#
# For each event it reads the run that started 5-11 h before (sunrise: 06Z,
# sunset: 18Z) and the one 6 h earlier. A run reaches the app about 2-4 h after
# it starts, so the later run is about what the app holds 1-3 h before the event.
# Writes <raw dir>/om_runs.json (resumable; the free API slows down after a few
# hundred calls, so a full run takes about 40 minutes). merge.py then copies it
# to where the analysis reads it.
import sys, os, json, gzip, time, urllib.error, urllib.request, datetime as dt
REPO, RAW = sys.argv[1], sys.argv[2]
sys.path.insert(0, os.path.join(REPO, "scripts"))
import goes_cloud as g  # noqa: E402
beaches = {b["slug"]: b for b in g.load_beaches()}
_obs = os.path.join(RAW, "obs.json")
O = (json.load(open(_obs)) if os.path.exists(_obs) else json.load(gzip.open(_obs + ".gz")))[0]["results"]
events = sorted({(o["slug"], o["event_kind"], o["event_iso"]) for o in O if o["view"] == "solar"}, key=lambda e: (e[2], e[0]))
out_path = os.path.join(RAW, "om_runs.json")
done = json.load(open(out_path)) if os.path.exists(out_path) else {}
VARS = "cloud_cover,cloud_cover_low,cloud_cover_mid,cloud_cover_high,relative_humidity_2m"
for slug, kind, ev in events:
    b = beaches[slug]
    evt = dt.datetime.fromisoformat(ev.replace("Z", "+00:00"))
    # newest 6-hourly run that started at least 4.5 h before the event, and the one before it
    r0 = (evt - dt.timedelta(hours=4, minutes=30)).replace(minute=0, second=0, microsecond=0)
    r0 = r0.replace(hour=r0.hour - r0.hour % 6)
    for tag, run in (("late", r0), ("early", r0 - dt.timedelta(hours=6))):
        k = f"{slug}|{kind}|{ev}|{tag}"
        if k in done:
            continue
        url = (f"https://single-runs-api.open-meteo.com/v1/forecast?latitude={b['lat']}&longitude={b['lon']}"
               f"&hourly={VARS}&run={run.strftime('%Y-%m-%dT%H:%M')}&forecast_hours=20&models=gfs_seamless&timezone=UTC")
        try:
            for attempt in range(6):  # the free API allows a few hundred calls an hour: wait out a 429
                try:
                    j = json.load(urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "benchmark-script"}), timeout=30))
                    break
                except urllib.error.HTTPError as e:
                    if e.code != 429 or attempt == 5:
                        raise
                    time.sleep(90)
            h = j["hourly"]
            best = min(range(len(h["time"])), key=lambda i: abs(dt.datetime.fromisoformat(h["time"][i] + ":00+00:00") - evt))
            done[k] = {"run": run.isoformat().replace("+00:00", "Z"), "point_time": h["time"][best] + ":00Z",
                       "lead_from_run_min": round((evt - run).total_seconds() / 60),
                       "total": h["cloud_cover"][best], "low": h["cloud_cover_low"][best], "mid": h["cloud_cover_mid"][best],
                       "high": h["cloud_cover_high"][best], "humidity": h["relative_humidity_2m"][best]}
        except Exception as e:  # noqa: BLE001
            print("ERR", k, repr(e)[:160], flush=True)
        time.sleep(1.0)
    json.dump(done, open(out_path, "w"))
print("done", len(done))
