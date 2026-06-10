# Vision accuracy report

_197 labeled images compared._ Edit `labels.csv` (ground truth) and re-run `score_eval.py`.

### Seaweed  (n=5)

- **Exact accuracy:** 40%
- **Adjacent (±1) accuracy:** 80%
- **MAE (0–3 scale):** 0.80
- **Quadratic weighted kappa:** -0.15

Per-class recall:
- none: — (n=0)
- low: 0% (n=3)
- moderate: 100% (n=2)
- high: — (n=0)

Confusion (rows = truth, cols = predicted):

| truth \ pred | none | low | moderate | high |
|---|---|---|---|---|
| **none** | 0 | 0 | 0 | 0 |
| **low** | 0 | 0 | 2 | 1 |
| **moderate** | 0 | 0 | 2 | 0 |
| **high** | 0 | 0 | 0 | 0 |

### Crowd  (n=5)

- **Exact accuracy:** 100%
- **Adjacent (±1) accuracy:** 100%
- **MAE (0–4 scale):** 0.00
- **Quadratic weighted kappa:** 1.00

Per-class recall:
- empty: 100% (n=1)
- quiet: 100% (n=4)
- moderate: — (n=0)
- busy: — (n=0)
- packed: — (n=0)

Confusion (rows = truth, cols = predicted):

| truth \ pred | empty | quiet | moderate | busy | packed |
|---|---|---|---|---|---|
| **empty** | 1 | 0 | 0 | 0 | 0 |
| **quiet** | 0 | 4 | 0 | 0 | 0 |
| **moderate** | 0 | 0 | 0 | 0 | 0 |
| **busy** | 0 | 0 | 0 | 0 | 0 |
| **packed** | 0 | 0 | 0 | 0 | 0 |

### People count  (n=5)

- **MAE:** 1.2 people
- **Pearson correlation:** 0.95

### Seaweed exact-accuracy by time of day

- day (7–19 ET): 2/169 (1%)
- low-light: 0/28 (0%)
