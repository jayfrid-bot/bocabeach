# Rebuild the GOES-19 cloud-top read for every sun event a solar-view cam graded,
# from the newest scan that STARTED at least N minutes before the event, for
# several N. Uses scripts/goes_cloud.py's own functions on NOAA's public archive
# (read-only). Adapted from docs/benchmarks/2026-11-05-sun-recalibration/scripts/
# backfill_ir.py; the difference is the event window: the live feed reads the
# sun path only for an event within 120 min of the scan, so here the window is
# widened to keep the path read at long leads.
#
#   python3 backfill_ir.py <repo> <raw dir> [offsets] [shard i/n]
#
# Offsets are SCAN AGES at the event, in minutes. The app sees a scan 5-30 min
# after it starts, so a scan age of 75 is about what the app holds 60 min before
# the event, 105 -> 90 min, 135 -> 120 min, 195 -> 180 min.
# Needs h5py + numpy. Writes <raw dir>/ir_backfill.json (resumable); merge.py then
# puts it where the analysis reads it. A full run reads about 9 GB from NOAA
# (nothing is kept on disk) and takes about 25 minutes in three shards.
import sys, os, json, gzip, datetime as dt

REPO, RAW = sys.argv[1], sys.argv[2]
OFFSETS = [int(x) for x in (sys.argv[3] if len(sys.argv) > 3 else "20,75,105,135,195").split(",")]
sys.path.insert(0, os.path.join(REPO, "scripts"))
import goes_cloud as g  # noqa: E402

_near = g.sun_events_near
g.sun_events_near = lambda lat, lon, tz, ref, window_min=330: _near(lat, lon, tz, ref, 330)

beaches = {b["slug"]: b for b in g.load_beaches()}
_obs = os.path.join(RAW, "obs.json")
O = (json.load(open(_obs)) if os.path.exists(_obs) else json.load(gzip.open(_obs + ".gz")))[0]["results"]
events = sorted({(o["slug"], o["event_kind"], o["event_iso"]) for o in O if o["view"] == "solar"}, key=lambda e: (e[2], e[0]))
# Optional shard "i/n" (argv[4]): this run takes the event days whose ordinal % n == i
# and writes ir_backfill.<i>.json, so several runs can work side by side. Then run merge.py.
SHARD = sys.argv[4] if len(sys.argv) > 4 else None
if SHARD:
    si, sn = (int(x) for x in SHARD.split("/"))
    events = [e for e in events if dt.date.fromisoformat(e[2][:10]).toordinal() % sn == si]
out_path = os.path.join(RAW, f"ir_backfill.{si}.json" if SHARD else "ir_backfill.json")
done = json.load(open(out_path)) if os.path.exists(out_path) else {}
listing = {}


def keys_for(product, hour):
    k = (product, hour)
    if k not in listing:
        prefix = f"{product}/{hour.year}/{int(hour.strftime('%j')):03d}/{hour.hour:02d}/"
        listing[k] = {st: key for key in g.list_keys(prefix) if (st := g.start_time(key)) is not None}
    return listing[k]


def fetch(key):
    # No disk cache: a full run reads about 9 GB of granules. The parsed grids
    # are kept in memory for the few events that share a scan.
    return g._get(f"{g.BUCKET}/{key}", timeout=120)


grids = {}
box_px = max(1, round((g.IR_BOX_KM / g.PIXEL_KM - 1) / 2))
beam_px = max(1, round((g.IR_BEAM_BOX_KM / g.PIXEL_KM - 1) / 2))
n = 0
for slug, kind, ev in events:
    b = beaches.get(slug)
    if not b:
        print("no beach", slug)
        continue
    evt = dt.datetime.fromisoformat(ev.replace("Z", "+00:00"))
    for off in OFFSETS:
        k = f"{slug}|{kind}|{ev}|{off}"
        if k in done:
            continue
        target = evt - dt.timedelta(minutes=off)
        try:
            cands = {}
            for h in (target.replace(minute=0, second=0, microsecond=0) + dt.timedelta(hours=i) for i in (-1, 0)):
                m = keys_for(g.PRODUCT, h)
                ht = keys_for(g.HEIGHT_PRODUCT, h)
                for st in set(m) & set(ht):
                    if st <= target:
                        cands[st] = (m[st], ht[st])
            if not cands:
                done[k] = None
                continue
            st = max(cands)
            ak, hk = cands[st]
            if hk not in grids:
                if len(grids) > 12:
                    grids.clear()
                grids[hk] = g.load_ir_grid(fetch(ak), fetch(hk))
            read = g.ir_beach_read(grids[hk], b, st, g.MIN_VALID_PIXELS, box_px, beam_px)
            done[k] = {"granuleStartIso": st.isoformat().replace("+00:00", "Z"), "ir": read}
        except Exception as e:  # noqa: BLE001 - one bad granule must not stop the run
            print("ERR", k, repr(e)[:200], flush=True)
            continue
        n += 1
        if n % 25 == 0:
            print(n, k, flush=True)
    json.dump(done, open(out_path, "w"))
print("done", len(done))
