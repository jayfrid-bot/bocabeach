# Vision provider comparison

_Scored on 5 labeled image(s) (of 29 total). Label more in `labels.csv` for a stronger signal._

| Provider | n | Seaweed exact | Seaweed ±1 | Seaweed MAE | Seaweed κ | Crowd exact | People MAE | Errors |
|---|---|---|---|---|---|---|---|---|
| **gemini** | 1 | 100% | 100% | 0.00 | 1.00 | 100% | 0.0 | 4 |
| **groq** | 5 | 100% | 100% | 0.00 | 1.00 | 100% | 1.4 | 0 |

---

## Agreement (all providers, no labels needed)

Across **5** images all providers scored:
- **Seaweed agreement:** 2/5 (40%)
- **Crowd agreement:** 4/5 (80%)

### Seaweed disagreements (3) — best images to label next

| image | gemini | groq | labeled? |
|---|---|---|---|
| boca_s11_1780597776.jpg | high | moderate | ❓ |
| boca_s11_1780607760.jpg | high | moderate | ❓ |
| boca_s19_1780678553.jpg | moderate | low | ❓ |


---

## gemini

### Seaweed  (n=1)

- **Exact accuracy:** 100%
- **Adjacent (±1) accuracy:** 100%
- **MAE (0–3 scale):** 0.00
- **Quadratic weighted kappa:** 1.00

Per-class recall:
- none: — (n=0)
- low: — (n=0)
- moderate: 100% (n=1)
- high: — (n=0)

Confusion (rows = truth, cols = predicted):

| truth \ pred | none | low | moderate | high |
|---|---|---|---|---|
| **none** | 0 | 0 | 0 | 0 |
| **low** | 0 | 0 | 0 | 0 |
| **moderate** | 0 | 0 | 1 | 0 |
| **high** | 0 | 0 | 0 | 0 |

### Crowd  (n=1)

- **Exact accuracy:** 100%
- **Adjacent (±1) accuracy:** 100%
- **MAE (0–4 scale):** 0.00
- **Quadratic weighted kappa:** 1.00

Per-class recall:
- empty: — (n=0)
- quiet: 100% (n=1)
- moderate: — (n=0)
- busy: — (n=0)
- packed: — (n=0)

Confusion (rows = truth, cols = predicted):

| truth \ pred | empty | quiet | moderate | busy | packed |
|---|---|---|---|---|---|
| **empty** | 0 | 0 | 0 | 0 | 0 |
| **quiet** | 0 | 1 | 0 | 0 | 0 |
| **moderate** | 0 | 0 | 0 | 0 | 0 |
| **busy** | 0 | 0 | 0 | 0 | 0 |
| **packed** | 0 | 0 | 0 | 0 | 0 |

## groq

### Seaweed  (n=5)

- **Exact accuracy:** 100%
- **Adjacent (±1) accuracy:** 100%
- **MAE (0–3 scale):** 0.00
- **Quadratic weighted kappa:** 1.00

Per-class recall:
- none: — (n=0)
- low: 100% (n=3)
- moderate: 100% (n=2)
- high: — (n=0)

Confusion (rows = truth, cols = predicted):

| truth \ pred | none | low | moderate | high |
|---|---|---|---|---|
| **none** | 0 | 0 | 0 | 0 |
| **low** | 0 | 3 | 0 | 0 |
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
