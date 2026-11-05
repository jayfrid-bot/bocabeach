import sys, json, csv, statistics as st, collections
sys.argv = ['x', '.']; sys.path.insert(0, 'py')
import fit as F
from models import new_score, old_score, new_parts, NEW_DEFAULT, screen
FINAL = dict(NEW_DEFAULT, clear=62, peak=86, rise_end=20, plateau_end=70, full=60, ovc_start=60, ovc_floor=0.45,
             beam_free=20, beam_zero=90, beam_floor=0.75, aero_k=1.0)
json.dump(FINAL, open('final_params.json', 'w'), indent=1)
M = F.metrics; out = {}
out['fit_set_old'] = M(F.FIT, lambda e: old_score(e['inp']))
out['fit_set_new'] = M(F.FIT, lambda e: new_score(e['inp'], FINAL))
F.FREE = dict(clear=(40, 80), ovc_start=(40, 95), ovc_floor=(0.2, 1.0), beam_floor=(0.2, 1.0))
F.NEW_DEFAULT.clear(); F.NEW_DEFAULT.update(FINAL)
preds = {}
for d in sorted({e['date'] for e in F.FIT}):
    pd, _ = F.fit([e for e in F.FIT if e['date'] != d], seed=1)
    for e in F.FIT:
        if e['date'] == d: preds[id(e)] = new_score(e['inp'], pd)
out['fit_set_new_lodo_refit'] = M(F.FIT, lambda e: preds[id(e)])
early = [e for e in F.FIT if e['date'] <= '2026-10-26']; late = [e for e in F.FIT if e['date'] > '2026-10-26']
pe, _ = F.fit(early, seed=2)
out['time_split_late_old'] = M(late, lambda e: old_score(e['inp']))
out['time_split_late_new_fit_on_early'] = M(late, lambda e: new_score(e['inp'], pe))
out['time_split_params_fit_on_early'] = {k: round(pe[k], 2) for k in F.FREE}
for kind in ('sunrise', 'sunset'):
    es = [e for e in F.FIT if e['kind'] == kind]
    out[f'{kind}_old'] = M(es, lambda e: old_score(e['inp'])); out[f'{kind}_new'] = M(es, lambda e: new_score(e['inp'], FINAL))
# Live archive: what the app actually said (last prediction 0-60 min out) vs the new model on the SAME archived inputs
P = json.load(open('preds.json'))[0]['results']; last = {}
for r in P:
    if 0 <= r['lead_minutes'] <= 60 and r['model_path'] == 'factor':
        k = (r['slug'], r['event_kind'], r['event_iso'][:16])
        if k not in last or r['snapshot_generated_at'] > last[k]['snapshot_generated_at']: last[k] = r
byk = {(e['slug'], e['kind'], e['event_iso'][:16]): e for e in F.E}
live = collections.defaultdict(list)
for k, r in last.items():
    e = byk.get(k)
    if not e: continue
    b = json.loads(r['breakdown_json'] or '{}')
    beam = r['horizon_cloud_pct'] if (b.get('source') == 'satellite-ir' and r['horizon_source'] == 'ir-beam') else None
    inp = dict(low=r['low_cloud_pct'], mid=r['mid_cloud_pct'], high=r['high_cloud_pct'], total=r['total_cloud_pct'], beam=beam, aod=r['aod'], pm25=r['pm2_5'], rh=r['humidity_pct'])
    live[k[0]].append(dict(e, live=r['score'], live_inp=inp, new_live=new_score(inp, FINAL)))
for slug, es in sorted(live.items()):
    out[f'live_{slug}_archived'] = M(es, lambda e: e['live']); out[f'live_{slug}_new_same_inputs'] = M(es, lambda e: e['new_live'])
allive = [x for v in live.values() for x in v]
out['live_all_archived'] = M(allive, lambda e: e['live']); out['live_all_new_same_inputs'] = M(allive, lambda e: e['new_live'])
# within-cam rank correlation, every cam (trusted or not)
rows = list(csv.DictReader(open('dataset.csv')))
def rank(xs):
    o = sorted(range(len(xs)), key=lambda i: xs[i]); r = [0] * len(xs)
    i = 0
    while i < len(o):
        j = i
        while j + 1 < len(o) and xs[o[j + 1]] == xs[o[i]]: j += 1
        for k in range(i, j + 1): r[o[k]] = (i + j) / 2
        i = j + 1
    return r
def spear(a, b): return round(st.correlation(rank(a), rank(b)), 2) if len(set(a)) > 1 and len(set(b)) > 1 else None
num = lambda x: float(x) if x not in ('', None) else None
cam = collections.defaultdict(list)
for r in rows:
    if r['slug'] == 'boca-raton': continue
    inp = {f: num(r[f]) for f in ('low', 'mid', 'high', 'total', 'beam', 'aod', 'pm25', 'rh')}
    r['new_model'] = new_score(inp, FINAL); cam[r['cam']].append(r)
out['per_cam'] = {c: dict(n=len(v), trusted=c in F.TRUSTED, obs_mean=round(st.mean(float(x['obs_clean']) for x in v)), obs_sd=round(st.pstdev([float(x['obs_clean']) for x in v])),
                    spearman_old=spear([float(x['old_model']) for x in v], [float(x['obs_clean']) for x in v]),
                    spearman_new=spear([float(x['new_model']) for x in v], [float(x['obs_clean']) for x in v])) for c, v in sorted(cam.items())}
# sky categories
def cat(i):
    mh = screen(i['mid'], i['high']); t = i['total']; b = i['beam'] if i['beam'] is not None else i['low']
    if t >= 90 and mh >= 60: return 'A solid mid/high deck (total >= 90%)'
    if t >= 85: return 'B overcast, mostly low cloud'
    if b >= 50: return 'C low cloud in the sun path (>= 50%)'
    if mh >= 20: return 'D partial mid/high (20-85%), path clear'
    if t < 15: return 'E clear (total < 15%)'
    return 'F scattered low cloud only'
cats = collections.defaultdict(list)
for e in F.FIT: cats[cat(e['inp'])].append(e)
out['categories'] = {k: dict(n=len(v), cam_mean=round(st.mean(e['truth'] for e in v)), cam_median=round(st.median(e['truth'] for e in v)),
                       old_mean=round(st.mean(old_score(e['inp']) for e in v)), new_mean=round(st.mean(new_score(e['inp'], FINAL) for e in v))) for k, v in sorted(cats.items())}
def bands(f):
    c = collections.Counter()
    for e in F.FIT:
        s = f(e); c['Amazing 90+' if s >= 90 else 'Great 70-89' if s >= 70 else 'Good 45-69' if s >= 45 else 'Fair 20-44' if s >= 20 else 'Poor <20'] += 1
    return dict(c)
out['bands_old'] = bands(lambda e: old_score(e['inp'])); out['bands_new'] = bands(lambda e: new_score(e['inp'], FINAL))
out['bands_truth'] = bands(lambda e: e['truth'])
json.dump(out, open('eval.json', 'w'), indent=1)
for k, v in out.items(): print(k, v)
# final dataset with model columns
fields = list(rows[0].keys())
with open('dataset_final.csv', 'w', newline='') as f:
    w = csv.DictWriter(f, fieldnames=fields + (['new_model'] if 'new_model' not in fields else []), extrasaction='ignore'); w.writeheader()
    for r in rows:
        inp = {f2: num(r[f2]) for f2 in ('low', 'mid', 'high', 'total', 'beam', 'aod', 'pm25', 'rh')}
        r['new_model'] = new_score(inp, FINAL); r['trusted_cam'] = int(r['cam'] in F.TRUSTED); w.writerow(r)
# Boca table for the report
for e in sorted(live['boca-raton'], key=lambda e: e['date']):
    print(e['date'], 'live', e['live'], 'new', e['new_live'], 'cams', round(e['truth']), [round(x) for x in e['obs']])
