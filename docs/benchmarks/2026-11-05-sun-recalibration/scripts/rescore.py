# Re-score every saved solar-view frame with scripts/sun_cam_check.py's own
# score_image, and add the sky brightness so dark pre-dawn / post-dusk frames
# (lamps, LEDs, noise) can be told apart from lit sky.
import sys, os, json, glob, statistics as st
from datetime import datetime, timezone
REPO, D = sys.argv[1], sys.argv[2]
sys.path.insert(0, os.path.join(REPO, "scripts"))
import sun_cam_check as s
from PIL import Image
cams = {c["id"]: c for c in json.load(open(os.path.join(REPO, "config/sun-cams.json")))["cams"]}
O = json.load(open(os.path.join(D, "obs.json")))[0]["results"]
out_path = os.path.join(D, "rescore.json")
out = json.load(open(out_path)) if os.path.exists(out_path) else {}
def sky_v(img, regions):
    rgb = img.convert("HSV"); w, h = rgb.size; vals = []
    for x0, y0, x1, y1 in regions:
        crop = rgb.crop((int(x0*w), int(y0*h), max(int(x1*w), int(x0*w)+1), max(int(y1*h), int(y0*h)+1))).reduce(4)
        vals += list(crop.tobytes()[2::3])
    vals.sort()
    return vals[len(vals)//2] / 255.0, sum(vals) / len(vals) / 255.0
seen = set()
for o in O:
    if o["view"] != "solar" or o["event_date_local"] < "2026-10-15": continue
    key = f'{o["event_date_local"]}|{o["event_kind"]}|{o["cam_id"]}'
    if key in seen or key in out: continue
    seen.add(key)
    files = sorted(f for f in glob.glob(f'{D}/frames/{o["event_date_local"]}/{o["event_kind"]}/{o["cam_id"]}/*.jpg') if not os.path.basename(f).startswith("peak"))
    if not files: continue
    regions = cams[o["cam_id"]]["sky_regions"] if "sky_regions" in cams[o["cam_id"]] else cams[o["cam_id"]]["regions"]
    ev = datetime.fromisoformat(o["event_iso"].replace("Z", "+00:00"))
    frames = []
    for f in files:
        hhmmss = os.path.basename(f)[:6]
        t = ev.replace(hour=int(hhmmss[:2]), minute=int(hhmmss[2:4]), second=int(hhmmss[4:6]), microsecond=0)
        dmin = (t - ev).total_seconds() / 60
        if dmin > 720: dmin -= 1440
        if dmin < -720: dmin += 1440
        with Image.open(f) as im:
            im.load(); sc = s.score_image(im, regions); med, mean = sky_v(im, regions)
        frames.append({"t": (ev.timestamp() + dmin*60), "min": round(dmin, 1), "score": round(sc["score"], 1), "valid": round(sc["valid_frac"], 3), "warm": round(sc["warm_frac"], 3), "v_med": round(med, 3), "v_mean": round(mean, 3)})
    out[key] = {"slug": o["slug"], "event_iso": o["event_iso"], "frames": frames}
    print(key, len(frames), flush=True)
    json.dump(out, open(out_path, "w"))
print("done", len(out))
