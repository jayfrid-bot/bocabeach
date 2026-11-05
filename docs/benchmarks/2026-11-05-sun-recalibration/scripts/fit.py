import csv, json, sys, statistics as st, itertools, random, collections
sys.path.insert(0, sys.argv[1] + '/py'); D = sys.argv[1]
from models import old_score, new_score, NEW_DEFAULT
TRUSTED = {'deerfield-beach-cam','deerfield-pier-cam','ftl-elbo-beach-cam','fort-myers-beach-cam','fort-zachary-taylor-cam',
           'holmes-beach-cam','pink-shell-fmb-cam','sharkys-pcb-cam','siesta-beach-cam','enco-shores-of-panama-cam',
           'margaritaville-fmb-cam','pensacola-sria-west-cam'}
rows = list(csv.DictReader(open(f'{D}/dataset.csv')))
num = lambda x: float(x) if x not in ('', None) else None
ev = collections.OrderedDict()
for r in rows:
    if r['cam'] not in TRUSTED or r['obs_clean'] == '': continue
    k = (r['slug'], r['kind'], r['event_iso'])
    e = ev.setdefault(k, dict(slug=r['slug'], kind=r['kind'], date=r['date'], event_iso=r['event_iso'], cams=[], obs=[], archived=num(r['archived_pred']),
        inp={f: num(r[f]) for f in ('low','mid','high','total','beam','aod','pm25','rh')}))
    e['obs'].append(float(r['obs_clean'])); e['cams'].append(r['cam'])
E = [dict(e, truth=st.mean(e['obs'])) for e in ev.values()]
FIT = [e for e in E if e['slug'] != 'boca-raton']   # Boca shares Deerfield's cams: same truth, keep it out of the fit
def metrics(es, f):
    p = [f(e) for e in es]; t = [e['truth'] for e in es]
    hi = [(x, y) for x, y in zip(p, t) if x >= 85]; lo = [(x, y) for x, y in zip(p, t) if x < 45]
    great = [(x, y) for x, y in zip(p, t) if x >= 70]
    return dict(n=len(es), corr=round(st.correlation(p, t), 2) if st.pstdev(p) > 0 else None, mae=round(st.mean(abs(x - y) for x, y in zip(p, t)), 1),
                epic_calls=len(hi), epic_hit=round(sum(y >= 70 for _, y in hi) / len(hi), 2) if hi else None,
                great_calls=len(great), great_hit=round(sum(y >= 70 for _, y in great) / len(great), 2) if great else None,
                low_calls=len(lo), low_mean_truth=round(st.mean(y for _, y in lo)) if lo else None)
FREE = dict(clear=(40, 80), peak=(60, 95), full=(5, 60), ovc_start=(60, 95), ovc_floor=(0.2, 1.0), beam_floor=(0.2, 1.0))
def loss(es, p): return st.mean(abs(new_score(e['inp'], p) - e['truth']) for e in es)
def fit(es, seed=0):
    rnd = random.Random(seed); best = dict(NEW_DEFAULT); bl = loss(es, best)
    for it in range(1500):
        cand = dict(best)
        for k in rnd.sample(list(FREE), 2):
            lo, hi = FREE[k]; step = (hi - lo) * (0.25 if it < 600 else 0.06)
            cand[k] = min(hi, max(lo, cand[k] + rnd.uniform(-step, step)))
        if cand['peak'] < cand['clear'] + 5: continue          # partial cloud must beat a clear sky
        l = loss(es, cand)
        if l < bl: best, bl = cand, l
    return best, bl
if __name__ == '__main__':
    print('events', len(E), 'fit set', len(FIT), 'days', len({e['date'] for e in FIT}))
    p, l = fit(FIT)
    print('full-fit params', {k: round(v, 2) for k, v in p.items()}, 'MAE', round(l, 1))
    # leave-one-day-out
    preds = {}
    for d in sorted({e['date'] for e in FIT}):
        tr = [e for e in FIT if e['date'] != d]; pd, _ = fit(tr, seed=1)
        for e in FIT:
            if e['date'] == d: preds[id(e)] = new_score(e['inp'], pd)
    print('OLD  (all FIT)', metrics(FIT, lambda e: old_score(e['inp'])))
    print('NEW  LODO     ', metrics(FIT, lambda e: preds[id(e)]))
    print('NEW  in-sample', metrics(FIT, lambda e: new_score(e['inp'], p)))
    json.dump(p, open(f'{D}/fit_params.json', 'w'))
