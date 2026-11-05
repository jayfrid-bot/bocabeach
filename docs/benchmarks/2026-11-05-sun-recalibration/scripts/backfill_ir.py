# Rebuild the GOES IR cloud-top read the app would have used ~20 min before each
# observed sun event (the live archiver missed most sunsets: its daily build
# budget runs out ~16Z). Uses scripts/goes_cloud.py's own functions.
import sys, os, json, datetime as dt, csv, hashlib
REPO = sys.argv[1]; D = sys.argv[2]; OFFSETS = [int(x) for x in (sys.argv[3] if len(sys.argv) > 3 else "20").split(",")]
sys.path.insert(0, os.path.join(REPO, "scripts"))
import goes_cloud as g
CACHE = os.path.join(D, "granules"); os.makedirs(CACHE, exist_ok=True)
beaches = {b["slug"]: b for b in g.load_beaches()}
O = json.load(open(os.path.join(D, "obs.json")))[0]["results"]
events = sorted({(o["slug"], o["event_kind"], o["event_iso"]) for o in O if o["view"] == "solar" and o["event_date_local"] >= "2026-10-15"})
out_path = os.path.join(D, "ir_backfill.json")
done = json.load(open(out_path)) if os.path.exists(out_path) else {}
listing = {}
def keys_for(product, hour):
    k = (product, hour)
    if k not in listing:
        prefix = f"{product}/{hour.year}/{int(hour.strftime('%j')):03d}/{hour.hour:02d}/"
        listing[k] = {st: key for key in g.list_keys(prefix) if (st := g.start_time(key)) is not None}
    return listing[k]
def fetch(key):
    p = os.path.join(CACHE, hashlib.md5(key.encode()).hexdigest())
    if not os.path.exists(p):
        open(p, "wb").write(g._get(f"{g.BUCKET}/{key}", timeout=120))
    return open(p, "rb").read()
grids = {}
box_px = max(1, round((g.IR_BOX_KM / g.PIXEL_KM - 1) / 2)); beam_px = max(1, round((g.IR_BEAM_BOX_KM / g.PIXEL_KM - 1) / 2))
for slug, kind, ev in events:
    b = beaches.get(slug)
    if not b: print("no beach", slug); continue
    evt = dt.datetime.fromisoformat(ev.replace("Z", "+00:00"))
    for off in OFFSETS:
        k = f"{slug}|{kind}|{ev}|{off}"
        if k in done: continue
        target = evt - dt.timedelta(minutes=off)
        cands = {}
        for h in (target.replace(minute=0, second=0, microsecond=0) + dt.timedelta(hours=i) for i in (-1, 0)):
            m = keys_for(g.PRODUCT, h); ht = keys_for(g.HEIGHT_PRODUCT, h)
            for st in set(m) & set(ht):
                if st <= target: cands[st] = (m[st], ht[st])
        if not cands: done[k] = None; continue
        st = max(cands); ak, hk = cands[st]
        if hk not in grids:
            if len(grids) > 6: grids.clear()
            grids[hk] = g.load_ir_grid(fetch(ak), fetch(hk))
        read = g.ir_beach_read(grids[hk], b, st, g.MIN_VALID_PIXELS, box_px, beam_px)
        done[k] = {"granuleStartIso": st.isoformat().replace("+00:00", "Z"), "ir": read}
        print(k, st.isoformat(), (read or {}).get("lowPct"), (read or {}).get("highPct"), ((read or {}).get("events") or {}).get(kind, {}).get("beamLowPct"), flush=True)
    json.dump(done, open(out_path, "w"))
print("done", len(done))
