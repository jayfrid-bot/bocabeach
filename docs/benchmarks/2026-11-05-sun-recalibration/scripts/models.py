# Python ports of the sun-color model: OLD = lib/sunQuality.ts 2026-10-15.1,
# NEW = the recalibrated candidate (params dict). Inputs: dict with low, mid,
# high, total, beam (None = no path read), aod, pm25, rh.
def clamp(x, a, b): return min(b, max(a, x))
def lerp(x, pts):
    if x <= pts[0][0]: return pts[0][1]
    for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
        if x <= x1: return y0 + (x - x0) / (x1 - x0) * (y1 - y0)
    return pts[-1][1]
def low_clear(low): return clamp(100 - max(0, clamp(low, 0, 100) - 20) * (100 / 70), 0, 100)
def aero(aod, pm):
    m = 1.0
    if aod is not None: m *= 1.05 if aod < 0.15 else clamp(1 - (aod - 0.15) * 0.5, 0.75, 1)
    if pm is not None and pm > 35: m *= clamp(1 - (pm - 35) * 0.0035, 0.65, 1)
    return m
def humid(rh, has_aod):
    if has_aod or rh is None or rh <= 92: return 1
    return clamp(1 - (rh - 92) * 0.01, 0.92, 1)
def old_score(i):
    low, mid, high = i["low"], i["mid"], i["high"]
    amount = 0.5 * mid + 0.7 * high
    off = 35 - amount if amount < 35 else amount - 80 if amount > 80 else 0
    solid = 1 if mid <= 80 else clamp(1 - (mid - 80) / 20 * 0.65, 0.35, 1)
    canvas = clamp((100 - off * 2.2) * solid, 0, 100)
    clear = clamp(100 - i["beam"], 0, 100) if i.get("beam") is not None else low_clear(low)
    base = 0.85 * canvas * clear / 100 + 0.15 * 55
    return round(clamp(base * aero(i.get("aod"), i.get("pm25")) * humid(i.get("rh"), i.get("aod") is not None), 0, 100))
def screen(m, h): return (1 - (1 - m / 100) * (1 - h / 100)) * 100
NEW_DEFAULT = dict(clear=58, peak=88, rise_end=20, plateau_end=60, full=30,  # canvas curve over mid/high cover
                   ovc_start=80, ovc_floor=0.35,                              # overcast: total cover
                   beam_free=20, beam_zero=90, beam_floor=0.25,              # low cloud in the sun's path
                   aero_k=1.0)
def new_parts(i, p=NEW_DEFAULT):
    mh = round(screen(i["mid"], i["high"]))  # lib/sunQuality.ts combineMidHigh rounds
    pts = [(0, p["clear"]), (p["rise_end"], p["peak"]), (p["plateau_end"], p["peak"]), (100, p["full"])]
    canvas = lerp(mh, pts)
    total = i["total"] if i.get("total") is not None else screen(screen(i["low"], i["mid"]), i["high"])
    ovc = 1.0 if total <= p["ovc_start"] else 1 - (1 - p["ovc_floor"]) * (min(total, 100) - p["ovc_start"]) / (100 - p["ovc_start"])
    b = i["beam"] if i.get("beam") is not None else i["low"]
    path = 1.0 if b <= p["beam_free"] else max(p["beam_floor"], 1 - (1 - p["beam_floor"]) * (min(b, p["beam_zero"]) - p["beam_free"]) / (p["beam_zero"] - p["beam_free"]))
    a = aero(i.get("aod"), i.get("pm25")); a = 1 + (a - 1) * p["aero_k"]
    return dict(mh=mh, canvas=canvas, ovc=ovc, path=path, aero=a, total=total)
def new_score(i, p=NEW_DEFAULT):
    q = new_parts(i, p)
    return round(clamp(q["canvas"] * q["ovc"] * q["path"] * q["aero"] * humid(i.get("rh"), i.get("aod") is not None), 0, 100))
