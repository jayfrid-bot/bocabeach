#!/usr/bin/env python3
"""Re-score saved sun-cam frames with the current rules and re-upload them.

scripts/sun_cam_check.py saves every captured frame under
~/Projects/bocabeach-sunframes/<local-date>/<sunrise|sunset>/<cam-id>/ (HHMMSSZ.jpg at
low JPEG quality, plus peak-HHMMSSZ.jpg at full quality). When the scoring rules
change (SUN_CAM_SCORE_VERSION), this script re-reads those frames for past events,
scores every frame again (sky_median_v included), takes the robust peak with the
current rules (the dark-frame rule included), and POSTs the result to
/api/sun-observations with the current score_version. The route replaces a stored
row only when the incoming score_version is newer, so a second run changes nothing.
Docs: docs/SUN_CAM_CHECK.md ("Re-scoring saved frames").

Every event is scored from the low-quality HHMMSSZ.jpg frames, the peak too, so one
series is never a mix of two JPEG qualities. Frame times come from the file names
(whole seconds) and are snapped back to the original 2.5-minute sample times of the
cam's event, so the re-scored series carries the same instants as the first upload.

USAGE (on the home server, from the repo root):
  /opt/homebrew/bin/python3 scripts/sun_cam_rescore.py --dry-run --stored FILE                 # print old vs new, upload nothing
  /opt/homebrew/bin/python3 scripts/sun_cam_rescore.py --stored FILE --changed-only            # upload only what the new rules change
  /opt/homebrew/bin/python3 scripts/sun_cam_rescore.py --stored FILE                           # re-score and upload every older row
  Options: --since YYYY-MM-DD  --until YYYY-MM-DD  --cams a,b  --events sunrise,sunset
           --frames-root DIR  --stored FILE  --changed-only  --verbose

  --changed-only: upload only the beach-events whose score under the new rules differs
    from the score of the same saved frames under the 2026-10-15.1 rules. The rest keep
    their stored row, which was scored on the full-quality originals (see "JPEG
    quality" in the report: re-scoring the low-quality copies moves a few events by
    more than 5 points for no reason but the compression).

  --stored FILE (REQUIRED for a real run): the stored scores to compare with, as the JSON that
    npx wrangler d1 execute isitbeachday-plus --remote --json --command \\
      "SELECT slug, event_kind, event_date_local, cam_id, observed_score, score_version FROM sun_event_observations"
  prints (a plain list of rows works too). A row already at the current score_version
  (or newer) is never re-uploaded: the live job scored it from the full-quality frames.
  A dry run without --stored takes the old score from the live job's state file, which
  keeps only the last 14 days.

The report has, per beach and event: the stored score and version, the score of
the saved frames under the 2026-10-15.1 rules (no dark rule), the new score, and
how many dark frames were dropped. "jpeg" lines compare the full-quality peak frame
with its low-quality copy. Exit code: 0, or 1 when any upload failed.
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

sys.path.insert(0, str(Path(__file__).resolve().parent))
import sun_cam_check as sc  # noqa: E402

SNAP_SECONDS = 2.0  # a file name drops the milliseconds; snap to a sample time this close
SKY_V_OFFSETS = (-35.0, -25.0, -15.0, 0.0, 15.0, 25.0)  # the minutes shown in the sky-brightness table


def load_stored(path: Optional[str]) -> Dict[str, Dict[str, Any]]:
    """Stored rows keyed by sc.state_key. From a wrangler --json export, a plain row list, or the state file."""
    out: Dict[str, Dict[str, Any]] = {}
    if path:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
        rows: List[Dict[str, Any]] = []
        if isinstance(data, list) and data and isinstance(data[0], dict) and "results" in data[0]:
            for block in data:
                rows.extend(block.get("results") or [])
        elif isinstance(data, list):
            rows = data
        for r in rows:
            key = sc.state_key(r["slug"], r["event_kind"], r["event_date_local"], r["cam_id"])
            out[key] = {"score": r.get("observed_score"), "score_version": r.get("score_version"), "source": "d1"}
        return out
    for key, v in sc.load_state().get("done", {}).items():
        if isinstance(v, dict) and v.get("status") == "uploaded":
            out[key] = {"score": v.get("score"), "score_version": v.get("score_version"), "source": "state"}
    return out


def version_key(v: Any) -> Optional[Tuple[str, int]]:
    """(date, N) of a YYYY-MM-DD.N score_version, the order the route uses; None when it is not one."""
    if not isinstance(v, str) or len(v) < 12 or v[10] != ".":
        return None
    try:
        return v[:10], int(v[11:])
    except ValueError:
        return None


def frame_time(name: str, local_date: date, cam_event: datetime, samples: List[datetime]) -> Optional[datetime]:
    """The capture instant of a saved frame: the UTC HHMM[SS] in its name, on the day within 12 h of the
    event, snapped to the original sample time when one is within SNAP_SECONDS."""
    m = sc.FRAME_RE.match(name)
    if not m:
        return None
    hh, mm, ss = int(m.group(1)), int(m.group(2)), int(m.group(3) or 0)
    t = datetime(local_date.year, local_date.month, local_date.day, hh, mm, ss, tzinfo=timezone.utc)
    while t - cam_event > timedelta(hours=12):
        t -= timedelta(days=1)
    while cam_event - t > timedelta(hours=12):
        t += timedelta(days=1)
    near = min(samples, key=lambda s: abs((s - t).total_seconds()))
    return near if abs((near - t).total_seconds()) <= SNAP_SECONDS else t


def score_event_dir(d: Path, cam: Dict[str, Any], local_date: date, kind: str) -> Tuple[List[Dict[str, Any]], Optional[Tuple[float, float]]]:
    """Every saved low-quality frame, scored. Plus (full-quality peak score, its low-quality copy's score)
    when the dir holds a peak- file."""
    cam_event = sc.sun_times(cam["lat"], cam["lon"], local_date)[kind]
    samples = sc.sample_times(cam_event)
    frames: List[Dict[str, Any]] = []
    for p in sorted(d.iterdir()):
        if not p.is_file() or p.name.lower().startswith("peak-"):
            continue
        t = frame_time(p.name, local_date, cam_event, samples)
        if t is None:
            continue
        m = sc.score_file(p, cam["sky_regions"])
        m["t"] = t
        m["path"] = str(p)
        frames.append(m)
    frames.sort(key=lambda f: f["t"])
    jpeg = None
    peaks = [p for p in d.iterdir() if p.is_file() and p.name.lower().startswith("peak-") and sc.FRAME_RE.match(p.name)]
    if peaks:
        low = d / peaks[0].name[len("peak-"):]
        if low.exists():
            jpeg = (round(sc.score_file(peaks[0], cam["sky_regions"])["score"], 1), round(sc.score_file(low, cam["sky_regions"])["score"], 1))
    return frames, jpeg


def fmt(v: Any) -> str:
    return "-" if v is None else (f"{v:.1f}" if isinstance(v, (int, float)) else str(v))


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(description="Re-score saved sun-cam frames with the current rules and re-upload.")
    ap.add_argument("--dry-run", action="store_true", help="print old vs new per event; upload nothing")
    ap.add_argument("--since", help="first local date to re-score (YYYY-MM-DD)")
    ap.add_argument("--until", help="last local date to re-score (YYYY-MM-DD)")
    ap.add_argument("--cams", help="comma-separated cam ids (default: all)")
    ap.add_argument("--events", default="sunrise,sunset", help="sunrise, sunset or both (default)")
    ap.add_argument("--frames-root", default=str(sc.FRAMES_ROOT), help=f"default {sc.FRAMES_ROOT}")
    ap.add_argument("--stored", help="JSON export of sun_event_observations to compare with (see the header)")
    ap.add_argument("--changed-only", action="store_true", help="upload only beach-events the new rules change")
    ap.add_argument("--verbose", action="store_true", help="also list each dropped dark frame")
    args = ap.parse_args(argv)
    try:
        import PIL  # noqa: F401
    except ImportError:
        print("Pillow is missing: pip install pillow", file=sys.stderr)
        return 2

    cfg = sc.load_config()
    cams = {c["id"]: c for c in cfg["cams"]}
    only = set(args.cams.split(",")) if args.cams else None
    kinds = [k for k in args.events.split(",") if k in ("sunrise", "sunset")]
    stored = load_stored(args.stored)
    current = version_key(sc.SUN_CAM_SCORE_VERSION)
    token = None
    if not args.dry_run:
        if not args.stored:
            # Without the stored versions the script cannot tell an old row from one already scored at this
            # version (from the full-quality originals), and the route would let a later scored_at replace it.
            sc.log("ERROR: a real run needs --stored (a fresh export of sun_event_observations); see the header")
            return 2
        token = sc.read_token()
        if not token:
            sc.log(f"ERROR: token file missing or empty at {sc.TOKEN_FILE}")
            return 1

    root = Path(args.frames_root).expanduser()
    print(f"sun-cam re-score | rules {sc.SUN_CAM_SCORE_VERSION} | frames {root} | stored scores from {args.stored or 'the state file'}"
          f" | dark rule: sky_median_v < {sc.DARK_SKY_V:.2f} at {sc.DARK_RULE_MIN_OFFSET_MIN}+ min from the event"
          + (" | DRY RUN" if args.dry_run else ""))
    print(f"{'date':<11}{'event':<8}{'cam':<28}{'beach':<20}{'view':<10}{'stored':>7} {'version':<13}{'old@saved':>10}{'new':>7}{'dark':>5}  status")

    rows: List[Dict[str, Any]] = []
    jpeg_pairs: List[Tuple[str, float, float]] = []
    sky_v: Dict[Tuple[str, str], Dict[float, List[float]]] = {}
    failures = 0
    for day_dir in sorted(p for p in root.iterdir() if p.is_dir()):
        try:
            local_date = date.fromisoformat(day_dir.name)
        except ValueError:
            continue
        if (args.since and day_dir.name < args.since) or (args.until and day_dir.name > args.until):
            continue
        for kind in kinds:
            kind_dir = day_dir / kind
            if not kind_dir.is_dir():
                continue
            for cam_dir in sorted(p for p in kind_dir.iterdir() if p.is_dir()):
                cam = cams.get(cam_dir.name)
                if cam is None or (only and cam["id"] not in only):
                    continue
                frames, jpeg = score_event_dir(cam_dir, cam, local_date, kind)
                if not frames:
                    continue
                if jpeg:
                    jpeg_pairs.append((f"{local_date} {kind} {cam['id']}", jpeg[0], jpeg[1]))
                cam_event = sc.sun_times(cam["lat"], cam["lon"], local_date)[kind]
                table = sky_v.setdefault((cam["id"], kind), {})
                for f in frames:
                    m = round((f["t"] - cam_event).total_seconds() / 60.0, 1)
                    if m in SKY_V_OFFSETS:
                        table.setdefault(m, []).append(f["sky_median_v"])
                view = sc.view_for(sc.cam_facing(cam), kind)
                for b in cam["beaches"]:
                    ev = sc.sun_times(b["lat"], b["lon"], local_date)[kind]
                    if ev is None:
                        continue
                    key = sc.state_key(b["slug"], kind, local_date.isoformat(), cam["id"])
                    old = stored.get(key, {})
                    old_res, _ = sc.build_result(frames, ev, dark_rule=False)
                    new_res, info = sc.build_result(frames, ev)
                    row = {
                        "date": local_date.isoformat(), "kind": kind, "cam": cam["id"], "slug": b["slug"], "view": view,
                        "stored": old.get("score"), "version": old.get("score_version"),
                        "old_saved": old_res["observed_score"] if old_res else None,
                        "new": new_res["observed_score"] if new_res else None, "dark": info.get("dark", 0),
                    }
                    unchanged = old_res is not None and abs(new_res["observed_score"] - old_res["observed_score"]) < 0.05 if new_res else False
                    stored_v = version_key(old.get("score_version"))
                    if stored_v is not None and current is not None and stored_v >= current:
                        row["status"] = ("dry run: " if args.dry_run else "") + "already at this score version, not uploaded"
                    elif new_res is None:
                        row["status"] = "incomplete under the new rules, not uploaded: " + info["reason"]
                    elif args.changed_only and unchanged:
                        row["status"] = ("dry run: " if args.dry_run else "") + "the new rules change nothing, not uploaded"
                    elif args.dry_run:
                        row["status"] = "dry run: would upload"
                    else:
                        payload = sc.payload_for(cam, b, kind, local_date.isoformat(), sc.iso_z(ev), view, new_res)
                        ok, msg = sc.post_observation(payload, token or "")
                        row["status"] = ("uploaded " if ok else "FAILED ") + msg
                        failures += 0 if ok else 1
                    rows.append(row)
                    print(f"{row['date']:<11}{kind:<8}{cam['id']:<28}{b['slug']:<20}{view:<10}{fmt(row['stored']):>7} {fmt(row['version']):<13}"
                          f"{fmt(row['old_saved']):>10}{fmt(row['new']):>7}{row['dark']:>5}  {row['status']}", flush=True)
                    if args.verbose and info.get("dark"):
                        for f in frames:
                            if f["valid_frac"] >= sc.MIN_USABLE_VALID_FRAC and sc.is_dark_frame(f, ev):
                                m = (f["t"] - ev).total_seconds() / 60.0
                                print(f"    dark frame {sc.iso_z(f['t'])} ({m:+.1f} min): sky V {f['sky_median_v']:.3f}, score {f['score']:.1f}")

    summarize(rows, jpeg_pairs, sky_v)
    return 1 if failures else 0


def summarize(rows: List[Dict[str, Any]], jpeg_pairs: List[Tuple[str, float, float]], sky_v: Dict[Tuple[str, str], Dict[float, List[float]]]) -> None:
    print("\n=== Summary ===")
    complete = [r for r in rows if r["new"] is not None]
    print(f"beach-events re-scored: {len(rows)}; complete under the new rules: {len(complete)}")
    lost = [r for r in rows if r["new"] is None and r["old_saved"] is not None]
    print(f"complete under the old rules but INCOMPLETE under the new: {len(lost)}")
    for r in lost:
        print(f"  {r['date']} {r['kind']} {r['cam']} {r['slug']}: old {fmt(r['old_saved'])}; {r['status']}")
    rule = [r for r in complete if r["old_saved"] is not None]
    moved = [r for r in rule if abs(r["new"] - r["old_saved"]) >= 0.1]
    print(f"\nThe dark rule alone (old rules vs new rules, same saved frames): {len(moved)} of {len(rule)} beach-events change")
    for r in sorted(moved, key=lambda r: r["new"] - r["old_saved"]):
        print(f"  {r['date']} {r['kind']:<8}{r['cam']:<28}{r['slug']:<20}{fmt(r['old_saved']):>6} -> {fmt(r['new']):>6} ({r['new'] - r['old_saved']:+.1f}), {r['dark']} dark frames dropped")
    vs = [r for r in complete if isinstance(r["stored"], (int, float))]
    if vs:
        d = [r["new"] - r["stored"] for r in vs]
        big = [r for r in vs if abs(r["new"] - r["stored"]) > 5]
        print(f"\nStored vs new (rule + re-scoring the low-quality saved frames): {len(vs)} beach-events with a stored score; "
              f"{sum(1 for x in d if abs(x) >= 0.1)} change; {len(big)} by more than 5; median change {statistics.median(d):+.1f}")
        dd = [r["old_saved"] - r["stored"] for r in vs if r["old_saved"] is not None]
        if dd:
            print(f"Re-scoring alone (old rules on the saved frames vs stored): median {statistics.median(dd):+.1f}, "
                  f"median |diff| {statistics.median(abs(x) for x in dd):.1f}, max |diff| {max(abs(x) for x in dd):.1f}, "
                  f"{sum(1 for x in dd if abs(x) > 5)} beach-events off by more than 5")
    for cam_id, kind in (("deerfield-pier-cam", "sunrise"), ("ftl-elbo-beach-cam", "sunrise")):
        sel = [r for r in rule if r["cam"] == cam_id and r["kind"] == kind]
        if sel:
            ch = [r for r in sel if abs(r["new"] - r["old_saved"]) >= 0.1]
            print(f"{cam_id} sunrises: {len(ch)} of {len(sel)} beach-events change under the dark rule; "
                  f"mean old {statistics.mean(r['old_saved'] for r in sel):.1f} -> mean new {statistics.mean(r['new'] for r in sel):.1f}")
    if jpeg_pairs:
        diffs = [lo - hi for _n, hi, lo in jpeg_pairs]
        print(f"\nJPEG quality: the full-quality peak frame vs its low-quality copy, {len(jpeg_pairs)} events: "
              f"median {statistics.median(diffs):+.1f}, median |diff| {statistics.median(abs(x) for x in diffs):.1f}, "
              f"max |diff| {max(abs(x) for x in diffs):.1f}, {sum(1 for x in diffs if abs(x) > 5)} off by more than 5")
        for n, hi, lo in sorted(jpeg_pairs, key=lambda p: -abs(p[2] - p[1]))[:10]:
            print(f"  {n}: full {hi:.1f}, low {lo:.1f} ({lo - hi:+.1f})")
    print(f"\nMedian sky_median_v by minutes from the cam's event (n events), dark under {sc.DARK_SKY_V:.2f}:")
    print(f"  {'cam':<28}{'event':<9}" + "".join(f"{m:>+12.0f}" for m in SKY_V_OFFSETS))
    for (cam_id, kind), table in sorted(sky_v.items()):
        cells = []
        for m in SKY_V_OFFSETS:
            v = table.get(m)
            cells.append(f"{statistics.median(v):.2f} ({len(v):>2})" if v else "-")
        print(f"  {cam_id:<28}{kind:<9}" + "".join(f"{c:>12}" for c in cells))


if __name__ == "__main__":
    sys.exit(main())
