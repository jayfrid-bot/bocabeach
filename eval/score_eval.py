#!/usr/bin/env python3
"""Compare eval/labels.csv (ground truth) with eval/predictions.csv -> report.md.

Pure stdlib. Treats seaweed/crowd as ORDINAL scales and reports exact + adjacent
accuracy, MAE, a confusion matrix, quadratic weighted kappa, and per-class recall;
plus MAE + correlation for people counts, and exact-accuracy split by capture hour.
"""
import csv
import os

DIR = os.path.dirname(os.path.abspath(__file__))
SEAWEED = ["none", "low", "moderate", "high"]
CROWD = ["empty", "quiet", "moderate", "busy", "packed"]


def load(name):
    path = os.path.join(DIR, name)
    if not os.path.exists(path):
        return {}
    with open(path) as fh:
        return {r["image"]: r for r in csv.DictReader(fh)}


def quad_kappa(yt, yp, k):
    obs = [[0] * k for _ in range(k)]
    for t, p in zip(yt, yp):
        obs[t][p] += 1
    n = len(yt) or 1
    row = [sum(obs[i]) for i in range(k)]
    col = [sum(obs[i][j] for i in range(k)) for j in range(k)]
    w = [[((i - j) ** 2) / ((k - 1) ** 2) for j in range(k)] for i in range(k)]
    exp = [[row[i] * col[j] / n for j in range(k)] for i in range(k)]
    num = sum(w[i][j] * obs[i][j] for i in range(k) for j in range(k))
    den = sum(w[i][j] * exp[i][j] for i in range(k) for j in range(k))
    return 1 - num / den if den else 1.0


def ordinal_block(title, pairs, scale):
    idx = {v: i for i, v in enumerate(scale)}
    pairs = [(t, p) for t, p in pairs if t in idx and p in idx]
    if not pairs:
        return f"### {title}\n\n_No comparable rows (check labels/predictions)._\n"
    yt = [idx[t] for t, p in pairs]
    yp = [idx[p] for t, p in pairs]
    n = len(pairs)
    exact = sum(t == p for t, p in zip(yt, yp)) / n
    adj = sum(abs(t - p) <= 1 for t, p in zip(yt, yp)) / n
    mae = sum(abs(t - p) for t, p in zip(yt, yp)) / n
    qwk = quad_kappa(yt, yp, len(scale))

    k = len(scale)
    cm = [[0] * k for _ in range(k)]
    for t, p in zip(yt, yp):
        cm[t][p] += 1

    out = [f"### {title}  (n={n})", ""]
    out.append(f"- **Exact accuracy:** {exact:.0%}")
    out.append(f"- **Adjacent (±1) accuracy:** {adj:.0%}")
    out.append(f"- **MAE (0–{k-1} scale):** {mae:.2f}")
    out.append(f"- **Quadratic weighted kappa:** {qwk:.2f}")
    out.append("")
    out.append("Per-class recall:")
    for c in range(k):
        tot = sum(1 for t in yt if t == c)
        rec = f"{sum(1 for t, p in zip(yt, yp) if t == c and p == c) / tot:.0%}" if tot else "—"
        out.append(f"- {scale[c]}: {rec} (n={tot})")
    out.append("")
    out.append("Confusion (rows = truth, cols = predicted):")
    out.append("")
    out.append("| truth \\ pred | " + " | ".join(scale) + " |")
    out.append("|" + "---|" * (k + 1))
    for i in range(k):
        out.append(f"| **{scale[i]}** | " + " | ".join(str(cm[i][j]) for j in range(k)) + " |")
    out.append("")
    return "\n".join(out)


def people_block(pairs):
    pts = []
    for t, p in pairs:
        try:
            pts.append((float(t), float(p)))
        except (TypeError, ValueError):
            continue
    if not pts:
        return "### People count\n\n_No numeric people labels yet._\n"
    n = len(pts)
    mae = sum(abs(a - b) for a, b in pts) / n
    mt = sum(a for a, _ in pts) / n
    mp = sum(b for _, b in pts) / n
    cov = sum((a - mt) * (b - mp) for a, b in pts)
    vt = sum((a - mt) ** 2 for a, _ in pts) ** 0.5
    vp = sum((b - mp) ** 2 for _, b in pts) ** 0.5
    corr = cov / (vt * vp) if vt and vp else float("nan")
    return (
        f"### People count  (n={n})\n\n"
        f"- **MAE:** {mae:.1f} people\n"
        f"- **Pearson correlation:** {corr:.2f}\n"
    )


def by_hour(labels, preds, manifest):
    rows = [im for im in labels if im in preds and im in manifest]
    buckets = {}
    for im in rows:
        cap = manifest[im].get("capturedAtUTC", "")
        try:
            hour_et = (int(cap[11:13]) - 4) % 24  # rough ET
        except (ValueError, IndexError):
            continue
        b = "day (7–19 ET)" if 7 <= hour_et < 19 else "low-light"
        ok = labels[im]["seaweed"] == preds[im]["seaweed"]
        d = buckets.setdefault(b, [0, 0])
        d[0] += ok
        d[1] += 1
    if not buckets:
        return ""
    out = ["### Seaweed exact-accuracy by time of day", ""]
    for b, (ok, tot) in buckets.items():
        out.append(f"- {b}: {ok}/{tot} ({ok / tot:.0%})")
    return "\n".join(out) + "\n"


def main() -> int:
    labels = load("labels.csv")
    preds = load("predictions.csv")
    manifest = load("manifest.csv")
    common = [im for im in labels if im in preds]
    if not common:
        print("No overlapping rows between labels.csv and predictions.csv", flush=True)
        return 1

    sea = [(labels[im]["seaweed"], preds[im]["seaweed"]) for im in common]
    crowd = [(labels[im].get("crowd", ""), preds[im].get("crowd", "")) for im in common]
    ppl = [(labels[im].get("people", ""), preds[im].get("people", "")) for im in common]

    report = [
        "# Vision accuracy report",
        "",
        f"_{len(common)} labeled images compared._ "
        "Edit `labels.csv` (ground truth) and re-run `score_eval.py`.",
        "",
        ordinal_block("Seaweed", sea, SEAWEED),
        ordinal_block("Crowd", crowd, CROWD),
        people_block(ppl),
        by_hour(labels, preds, manifest),
    ]
    text = "\n".join(report)
    with open(os.path.join(DIR, "report.md"), "w") as fh:
        fh.write(text)
    print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
