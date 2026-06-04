#!/usr/bin/env python3
"""Build eval/REVIEW.md — every test photo with YOUR answer vs the AI's read, so
you can eyeball the model's accuracy right on GitHub. Also adds a blank label row
for any new photo so none get missed. Pure stdlib."""
import csv
import glob
import os

DIR = os.path.dirname(os.path.abspath(__file__))
FIELDS = ["image", "seaweed", "crowd", "people"]


def load(name):
    path = os.path.join(DIR, name)
    if not os.path.exists(path):
        return {}
    with open(path) as fh:
        return {r["image"]: r for r in csv.DictReader(fh)}


def main() -> int:
    images = sorted(os.path.basename(p) for p in glob.glob(os.path.join(DIR, "images", "*.jpg")))
    labels = load("labels.csv")
    preds = load("predictions.csv")

    # Make sure every photo has a (possibly blank) label row to fill in.
    changed = False
    for im in images:
        if im not in labels:
            labels[im] = {"image": im, "seaweed": "", "crowd": "", "people": ""}
            changed = True
    if changed:
        with open(os.path.join(DIR, "labels.csv"), "w", newline="") as fh:
            w = csv.DictWriter(fh, fieldnames=FIELDS)
            w.writeheader()
            for im in images:
                w.writerow({k: labels[im].get(k, "") for k in FIELDS})

    body = []
    reviewed = 0
    disagree = 0
    for im in images:
        lab = labels.get(im, {})
        pred = preds.get(im, {})
        has_label = bool((lab.get("seaweed") or "").strip())
        if has_label:
            reviewed += 1

        def cell(field):
            you = (lab.get(field) or "").strip()
            ai = (pred.get(field) or "").strip()
            if not you:
                mark = "❓"
            elif you == ai:
                mark = "✅"
            else:
                mark = "⚠️"
            return you or "—", ai or "—", mark

        sw, cr, pe = cell("seaweed"), cell("crowd"), cell("people")
        if "⚠️" in (sw[2], cr[2]):
            disagree += 1
        body += [
            f"### {im}",
            "",
            f"![photo](images/{im})",
            "",
            "| | You (the truth) | AI said | |",
            "|---|---|---|---|",
            f"| **Seaweed** | {sw[0]} | {sw[1]} | {sw[2]} |",
            f"| **Crowd** | {cr[0]} | {cr[1]} | {cr[2]} |",
            f"| **People** | {pe[0]} | {pe[1]} |  |",
            "",
        ]

    header = [
        "# Eye‑test: your answer vs the AI",
        "",
        f"**{len(images)} photos · {reviewed} have your answer filled in · "
        f"{disagree} disagree (of the reviewed ones).**",
        "",
        "For each photo below, **You** is the correct answer and **AI said** is what the "
        "model guessed. If you disagree, just change the word in `labels.csv` — the grade "
        "updates itself.",
        "",
        "Legend: ✅ you and the AI agree · ⚠️ you differ · ❓ you haven't answered yet.",
        "",
        "---",
        "",
    ]
    with open(os.path.join(DIR, "REVIEW.md"), "w") as fh:
        fh.write("\n".join(header + body))
    print(f"wrote REVIEW.md ({len(images)} photos, {reviewed} reviewed, {disagree} disagreements)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
