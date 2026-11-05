# Join each solar-view sun-cam observation to the last archived prediction made
# 0-60 min before the event. Inputs (read-only D1 exports, into <dir>):
#   preds.json : SELECT slug,event_kind,event_iso,as_of_hour_utc,snapshot_generated_at,lead_minutes,score,band,
#                model_path,horizon_source,horizon_cloud_pct,horizon_fresh,low_cloud_pct,mid_cloud_pct,high_cloud_pct,
#                total_cloud_pct,humidity_pct,aod,pm2_5,seasonal_prior,algo_version,breakdown_json,observed_score
#                FROM sun_event_predictions WHERE event_iso >= '2026-10-15' AND lead_minutes BETWEEN -5 AND 180
#                AND slug IN (SELECT DISTINCT slug FROM sun_event_observations)
#   obs.json   : SELECT slug,event_kind,event_date_local,cam_id,event_iso,view,distance_mi,observed_score,warm_frac,
#                colorfulness,peak_frame_iso,series_json,score_version FROM sun_event_observations
#                WHERE event_date_local >= '2026-10-13'
#   latest.json: the latest (smallest non-negative lead) prediction row per event, for aod / pm2_5 / humidity:
#                SELECT p.slug,p.event_kind,p.event_iso,p.lead_minutes,p.score,p.humidity_pct,p.aod,p.pm2_5,
#                p.low_cloud_pct,p.mid_cloud_pct,p.high_cloud_pct FROM sun_event_predictions p JOIN (SELECT slug,
#                event_kind,event_iso,MIN(lead_minutes) ml FROM sun_event_predictions WHERE event_iso>='2026-10-15'
#                AND lead_minutes>=0 GROUP BY 1,2,3) m ON p.slug=m.slug AND p.event_kind=m.event_kind
#                AND p.event_iso=m.event_iso AND p.lead_minutes=m.ml
# Each: npx wrangler d1 execute isitbeachday-plus --remote --json --command "<query>" > <dir>/<name>.json
import json, csv, sys, statistics as st
D = sys.argv[1]
P = json.load(open(f'{D}/preds.json'))[0]['results']
O = json.load(open(f'{D}/obs.json'))[0]['results']
last = {}
for r in P:
    if not (0 <= r['lead_minutes'] <= 60): continue
    k = (r['slug'], r['event_kind'], r['event_iso'][:16])
    if k not in last or r['snapshot_generated_at'] > last[k]['snapshot_generated_at']:
        last[k] = r
rows = []
for o in O:
    if o['view'] != 'solar' or o['event_date_local'] < '2026-10-15': continue
    k = (o['slug'], o['event_kind'], o['event_iso'][:16])
    p = last.get(k)
    s = json.loads(o['series_json'])
    scores = [f['score'] for f in s]
    b = json.loads(p['breakdown_json'] or '{}') if p else {}
    sat = b.get('satellite') or {}
    flags = []
    if len(s) < 15: flags.append('few-frames')
    if o['observed_score'] < 3: flags.append('near-zero')
    if max(scores) - min(scores) < 3 and o['observed_score'] < 10: flags.append('flat-series')
    glow = [f.get('glow_masked_frac') or 0 for f in s]
    rows.append(dict(
        slug=o['slug'], event_kind=o['event_kind'], date=o['event_date_local'], cam_id=o['cam_id'],
        event_iso=o['event_iso'], observed=o['observed_score'], warm_frac=o['warm_frac'], colorfulness=o['colorfulness'],
        n_frames=len(s), series_min=min(scores), series_med=st.median(scores), series_max=max(scores),
        glow_max=round(max(glow), 3), peak_frame=o['peak_frame_iso'],
        has_pred=int(p is not None),
        lead=p['lead_minutes'] if p else None, pred=p['score'] if p else None, band=p['band'] if p else None,
        source=b.get('source') if p else None, horizon_source=p['horizon_source'] if p else None,
        horizon_pct=p['horizon_cloud_pct'] if p else None,
        low=p['low_cloud_pct'] if p else None, mid=p['mid_cloud_pct'] if p else None, high=p['high_cloud_pct'] if p else None,
        total=p['total_cloud_pct'] if p else None, rh=p['humidity_pct'] if p else None, aod=p['aod'] if p else None,
        pm25=p['pm2_5'] if p else None, sunward_mh=sat.get('sunwardMidHighPct'), anti_mh=sat.get('antiMidHighPct'),
        algo=p['algo_version'] if p else None, flags='|'.join(flags)))
rows.sort(key=lambda r: (r['event_iso'], r['slug'], r['cam_id']))
with open(f'{D}/dataset_raw.csv', 'w', newline='') as f:
    w = csv.DictWriter(f, fieldnames=list(rows[0].keys())); w.writeheader(); w.writerows(rows)
print(len(rows), sum(r['has_pred'] for r in rows))
