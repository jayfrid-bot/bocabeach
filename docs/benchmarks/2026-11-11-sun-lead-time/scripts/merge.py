# Put the rebuilt inputs where the analysis reads them: merge the shards that
# backfill_ir.py wrote (raw/ir_backfill.<i>.json, or raw/ir_backfill.json from a
# single run) into ir_backfill.json, and copy raw/om_runs.json to om_runs.json.
#   python3 merge.py <benchmark dir>
import sys, json, glob, os
B = sys.argv[1]
ir = {}
for f in sorted(glob.glob(os.path.join(B, "raw", "ir_backfill*.json"))):
    ir.update(json.load(open(f)))
if ir:
    json.dump(dict(sorted(ir.items())), open(os.path.join(B, "ir_backfill.json"), "w"), separators=(",", ":"))
runs = os.path.join(B, "raw", "om_runs.json")
if os.path.exists(runs):
    json.dump(dict(sorted(json.load(open(runs)).items())), open(os.path.join(B, "om_runs.json"), "w"), separators=(",", ":"))
print("satellite reads", len(ir), "| forecast runs file", os.path.exists(os.path.join(B, "om_runs.json")))
