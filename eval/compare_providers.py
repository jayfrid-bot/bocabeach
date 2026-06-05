#!/usr/bin/env python3
"""Run EACH configured vision provider over the eval images and score them
head-to-head against eval/labels.csv (your ground truth).

Writes eval/predictions_<provider>.csv (incremental cache, so re-runs are cheap)
and eval/providers_report.md with a side-by-side accuracy table + per-provider
detail. Needs each provider's key in the environment (CI has them). Choose which
to compare with EVAL_PROVIDERS="gemini,groq" (default). Pure stdlib + the
production provider code, so the eval exercises the exact same prompt/parsing.
"""
import csv
import glob
import os
import sys
import time

DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, DIR)
sys.path.insert(0, os.path.join(DIR, "..", "scripts"))

import cam_seaweed as cs  # noqa: E402  -- production provider primitives
from score_eval import CROWD, SEAWEED, ordinal_block, quad_kappa  # noqa: E402

DELAY = float(os.environ.get("EVAL_DELAY", "3"))
PROVIDERS = [
    p.strip() for p in os.environ.get("EVAL_PROVIDERS", "gemini,groq").split(",") if p.strip()
]
FIELDS = ["image", "seaweed", "crowd", "people"]


def load(name):
    path = os.path.join(DIR, name)
    if not os.path.exists(path):
        return {}
    with open(path) as fh:
        return {r["image"]: r for r in csv.DictReader(fh)}


def run_provider(name, images):
    """Score all images with one provider, caching to predictions_<name>.csv."""
    fname = f"predictions_{name}.csv"
    # Keep good cached rows, but DROP errored/blank ones so they get retried
    # (e.g. after fixing the Groq 403 or once Gemini's daily quota resets).
    done = {im: r for im, r in load(fname).items() if r.get("seaweed") not in ("", "ERROR")}
    todo = [p for p in images if os.path.basename(p) not in done]
    print(f"[{name}] {len(todo)} to score ({len(done)} cached)", flush=True)
    for i, path in enumerate(todo):
        im = os.path.basename(path)
        try:
            with open(path, "rb") as fh:
                r = cs.assess_with(name, fh.read())
            done[im] = {
                "image": im,
                "seaweed": r["level"],
                "crowd": r.get("crowd") or "",
                "people": r.get("people") if r.get("people") is not None else "",
            }
            print(f"  {im}: {r['level']}/{r.get('crowd')}/{r.get('people')}", flush=True)
        except Exception as e:  # noqa: BLE001
            done[im] = {"image": im, "seaweed": "ERROR", "crowd": "", "people": ""}
            print(f"  {im}: ERROR {e}", file=sys.stderr, flush=True)
        if i < len(todo) - 1:
            time.sleep(DELAY)
    with open(os.path.join(DIR, fname), "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=FIELDS)
        w.writeheader()
        for im in sorted(done):
            w.writerow({k: done[im].get(k, "") for k in FIELDS})
    return done


def metrics(pairs, scale):
    idx = {v: i for i, v in enumerate(scale)}
    pairs = [(t, p) for t, p in pairs if t in idx and p in idx]
    if not pairs:
        return None
    yt = [idx[t] for t, _ in pairs]
    yp = [idx[p] for _, p in pairs]
    n = len(pairs)
    return {
        "n": n,
        "exact": sum(t == p for t, p in zip(yt, yp)) / n,
        "adj": sum(abs(t - p) <= 1 for t, p in zip(yt, yp)) / n,
        "mae": sum(abs(t - p) for t, p in zip(yt, yp)) / n,
        "qwk": quad_kappa(yt, yp, len(scale)),
    }


def people_mae(pairs):
    pts = []
    for t, p in pairs:
        try:
            pts.append((float(t), float(p)))
        except (TypeError, ValueError):
            continue
    return sum(abs(a - b) for a, b in pts) / len(pts) if pts else None


def agreement_block(configured, preds_by, labels):
    """Inter-provider agreement across ALL images (no labels needed) + the
    disagreements, which are the highest-value images to label next."""
    if len(configured) < 2:
        return ""
    # Images every provider scored without error.
    images = sorted(
        set.intersection(*[
            {im for im, r in preds_by[n].items() if r["seaweed"] not in ("", "ERROR")}
            for n in configured
        ])
    )
    if not images:
        return "## Agreement\n\n_No images scored by all providers yet._\n"

    def all_agree(im, field):
        vals = {(preds_by[n][im].get(field) or "") for n in configured}
        return len(vals) == 1

    sea_agree = sum(all_agree(im, "seaweed") for im in images)
    crowd_agree = sum(all_agree(im, "crowd") for im in images)
    n = len(images)

    out = [
        "## Agreement (all providers, no labels needed)",
        "",
        f"Across **{n}** images all providers scored:",
        f"- **Seaweed agreement:** {sea_agree}/{n} ({sea_agree / n:.0%})",
        f"- **Crowd agreement:** {crowd_agree}/{n} ({crowd_agree / n:.0%})",
        "",
    ]
    disagree = [im for im in images if not all_agree(im, "seaweed")]
    if disagree:
        out += [
            f"### Seaweed disagreements ({len(disagree)}) — best images to label next",
            "",
            "| image | " + " | ".join(configured) + " | labeled? |",
            "|---|" + "---|" * (len(configured) + 1),
        ]
        for im in disagree[:40]:
            cells = " | ".join(preds_by[n][im].get("seaweed", "—") for n in configured)
            have = "✅" if (labels.get(im, {}).get("seaweed") or "").strip() else "❓"
            out.append(f"| {im} | {cells} | {have} |")
        out.append("")
    return "\n".join(out)


def main() -> int:
    configured = [p for p in PROVIDERS if cs._provider_configured(p)]
    skipped = [p for p in PROVIDERS if p not in configured]
    if not configured:
        print(f"no requested providers configured ({PROVIDERS}) — set their keys", file=sys.stderr)
        return 1

    labels = load("labels.csv")
    images = sorted(glob.glob(os.path.join(DIR, "images", "*.jpg")))
    preds_by = {name: run_provider(name, images) for name in configured}

    labeled = [im for im in labels if (labels[im].get("seaweed") or "").strip()]

    summary = []
    detail = []
    for name in configured:
        preds = preds_by[name]
        common = [
            im for im in labeled
            if im in preds and preds[im]["seaweed"] not in ("", "ERROR")
        ]
        sea_pairs = [(labels[im]["seaweed"], preds[im]["seaweed"]) for im in common]
        crowd_pairs = [(labels[im].get("crowd", ""), preds[im].get("crowd", "")) for im in common]
        ppl_pairs = [(labels[im].get("people", ""), preds[im].get("people", "")) for im in common]
        sea, crowd = metrics(sea_pairs, SEAWEED), metrics(crowd_pairs, CROWD)
        pm = people_mae(ppl_pairs)
        errs = sum(1 for im in labeled if im in preds and preds[im]["seaweed"] == "ERROR")
        summary.append((name, len(common), errs, sea, crowd, pm))
        detail.append(f"## {name}\n\n"
                      + ordinal_block("Seaweed", sea_pairs, SEAWEED) + "\n"
                      + ordinal_block("Crowd", crowd_pairs, CROWD))

    def cell(m, key, fmt):
        return fmt.format(m[key]) if m else "—"

    lines = [
        "# Vision provider comparison",
        "",
        f"_Scored on {len(labeled)} labeled image(s) (of {len(images)} total). "
        "Label more in `labels.csv` for a stronger signal._",
        "",
        "| Provider | n | Seaweed exact | Seaweed ±1 | Seaweed MAE | Seaweed κ | "
        "Crowd exact | People MAE | Errors |",
        "|---|---|---|---|---|---|---|---|---|",
    ]
    for name, n, errs, sea, crowd, pm in summary:
        lines.append(
            f"| **{name}** | {n} | {cell(sea,'exact','{:.0%}')} | {cell(sea,'adj','{:.0%}')} | "
            f"{cell(sea,'mae','{:.2f}')} | {cell(sea,'qwk','{:.2f}')} | "
            f"{cell(crowd,'exact','{:.0%}')} | "
            f"{(f'{pm:.1f}' if pm is not None else '—')} | {errs} |"
        )
    if skipped:
        lines += ["", f"_Not configured (skipped): {', '.join(skipped)}._"]
    lines += ["", "---", "", agreement_block(configured, preds_by, labels)]
    lines += ["", "---", ""] + detail

    text = "\n".join(lines)
    with open(os.path.join(DIR, "providers_report.md"), "w") as fh:
        fh.write(text)
    print("\n" + text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
