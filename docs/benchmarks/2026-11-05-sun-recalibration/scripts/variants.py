import sys; sys.argv=['x','.']; sys.path.insert(0,'py')
import fit as F
from models import new_score, NEW_DEFAULT
ORIG = dict(NEW_DEFAULT)
def run(name, fixed, free, es=None):
    F.FREE = free
    base = dict(ORIG); base.update(fixed)
    F.NEW_DEFAULT.clear(); F.NEW_DEFAULT.update(base)
    es = es or F.FIT
    preds={}
    for d in sorted({e['date'] for e in es}):
        tr=[e for e in es if e['date']!=d]; pd,_=F.fit(tr,seed=1)
        for e in es:
            if e['date']==d: preds[id(e)]=new_score(e['inp'],pd)
    p,l=F.fit(es)
    print(name, {k:round(v,2) for k,v in p.items() if k in free}, '\n   LODO', F.metrics(es, lambda e: preds[id(e)]), '\n   in  ', F.metrics(es, lambda e: new_score(e['inp'],p)))
    return p
if __name__=='__main__':
    ALL=dict(clear=(40,80), ovc_start=(60,95), ovc_floor=(0.2,1.0), beam_floor=(0.2,1.0))
    for pk in (75,85,90):
        run(f'peak{pk}', dict(peak=pk, full=45), ALL)
