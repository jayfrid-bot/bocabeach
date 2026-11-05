# One row per (beach, event, cam): reconstructed satellite inputs at T-20 min,
# the archived prediction (when one exists), the stored cam score and the
# cleaned cam score (dark outer-window frames dropped, robust peak recomputed).
import json, csv, sys, statistics as st, datetime as dt
sys.path.insert(0, sys.argv[1] + '/py'); D = sys.argv[1]
from models import old_score
B = json.load(open(f'{D}/ir_backfill.json')); R = json.load(open(f'{D}/rescore.json'))
O = json.load(open(f'{D}/obs.json'))[0]['results']; L = json.load(open(f'{D}/latest.json'))[0]['results']
latest = {(r['slug'], r['event_kind'], r['event_iso'][:16]): r for r in L}
raw = {(r['slug'], r['cam_id'], r['event_iso']): r for r in csv.DictReader(open(f'{D}/dataset_raw.csv'))}
DARK_V, OUTER_MIN = 0.30, 15
def robust_peak(fr):
    best = None
    for i, f in enumerate(fr):
        nb = [g['score'] for j, g in enumerate(fr) if j != i and abs(g['t'] - f['t']) <= 301]
        if not nb: continue
        v = min(f['score'], 2 * max(nb)); best = v if best is None or v > best else best
    return best
rows = []
for o in O:
    if o['view'] != 'solar' or o['event_date_local'] < '2026-10-15': continue
    key = f'{o["event_date_local"]}|{o["event_kind"]}|{o["cam_id"]}'
    rs = R.get(key); b = B.get(f'{o["slug"]}|{o["event_kind"]}|{o["event_iso"]}|20')
    rr = raw.get((o['slug'], o['cam_id'], o['event_iso']), {})
    row = dict(slug=o['slug'], kind=o['event_kind'], date=o['event_date_local'], cam=o['cam_id'], event_iso=o['event_iso'],
               obs_stored=o['observed_score'])
    flags = []
    if rs:
        fr = rs['frames']
        keep = [f for f in fr if not (f['v_med'] < DARK_V and abs(f['min']) >= OUTER_MIN)]
        row['n_frames'] = len(fr); row['n_dark_dropped'] = len(fr) - len(keep)
        rp = robust_peak(keep) if len(keep) >= 8 else None
        row['obs_clean'] = round(rp, 1) if rp is not None else None
        row['sky_v_event'] = round(st.median([f['v_med'] for f in fr if abs(f['min']) <= 8] or [0]), 3)
        if len(keep) < 15: flags.append('few-usable-frames')
        if rp is not None and rp < 3: flags.append('near-zero')
        if row['sky_v_event'] < 0.2: flags.append('dark-sky-at-event')
    else:
        row['obs_clean'] = None; flags.append('no-frames')
    ir = (b or {}).get('ir')
    if ir and (ir.get('unclassifiedPct') or 0) <= 20:
        ev = (ir.get('events') or {}).get(o['event_kind']) or {}
        lt = latest.get((o['slug'], o['event_kind'], o['event_iso'][:16])) or {}
        inp = dict(low=ir['lowPct'], mid=ir['midPct'], high=ir['highPct'], total=ir['irCloudPct'], beam=ev.get('beamLowPct'),
                   aod=lt.get('aod'), pm25=lt.get('pm2_5'), rh=lt.get('humidity_pct'))
        row.update({k: inp[k] for k in inp}); row['granule'] = b['granuleStartIso']
        row['sunward_mh'] = ev.get('beamMidHighPct'); row['anti_mh'] = ev.get('antiMidHighPct')
        row['old_model'] = old_score(inp)
    else:
        flags.append('no-satellite-read')
    row['archived_pred'] = rr.get('pred') or None; row['archived_lead'] = rr.get('lead') or None
    row['flags'] = '|'.join(flags); rows.append(row)
rows.sort(key=lambda r: (r['event_iso'], r['slug'], r['cam']))
fields = ['date','slug','kind','cam','event_iso','obs_stored','obs_clean','n_frames','n_dark_dropped','sky_v_event','granule','low','mid','high','total','beam','sunward_mh','anti_mh','aod','pm25','rh','old_model','archived_pred','archived_lead','flags']
with open(f'{D}/dataset.csv', 'w', newline='') as f:
    w = csv.DictWriter(f, fieldnames=fields, extrasaction='ignore'); w.writeheader(); w.writerows(rows)
print(len(rows), 'with inputs', sum(1 for r in rows if 'old_model' in r), 'with clean truth', sum(1 for r in rows if r.get('obs_clean') is not None))
