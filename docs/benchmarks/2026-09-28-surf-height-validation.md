# Surf-height estimate validation (2026-09-28)

**Question:** does `breakerHeightM`/`estimateSurfHeightFt` (`lib/surfHeight.ts`,
the Komar & Gaughan 1972 breaker-height relation) turn NDBC 41122's raw
significant wave height (Hs) into a number that actually matches what people
see breaking on the beach — and does NDBC's DPD (dominant/peak period) or APD
(average period) fit better as the period input?

**Data:** NDBC 41122 realtime2 feed (45-day rolling window), fetched live
2026-09-28. WVHT (col 9, m) = Hs; DPD (col 10, s); APD (col 11, s).

## Anchor (a): calm day, 2026-09-18 daytime (10 AM–6 PM ET)

The owner stood on Boca beach on 9/18 and saw "a little over 1 foot." The
buoy that day was short-period wind chop, not swell — DPD ran 3–6 s, nothing
like a real groundswell.

| Period used | Hs avg | Period avg | Estimated surf (avg, range) |
|---|---|---|---|
| DPD | 1.64 ft | 3.4 s | **1.80 ft** (1.31–2.64 ft) |
| APD | 1.64 ft | 3.0 s | 1.73 ft (1.31–2.30 ft) |

Both land within ~0.5 ft of "a little over 1 foot" — expected, since a
short period barely amplifies Hs at all (many hourly readings have DPD ≤ 3 s
and fall back to `Hb = Hs` under the guard). Not a discriminating case.

## Anchor (b): swell day, NWS Surf Zone Forecast, Coastal Palm Beach zone

Confirmed live against the actual issued product
(`api.weather.gov/products/types/SRF/locations/MFL`, product issued 4:21 PM
EDT 9/27/2026, zone `FLZ168 — Coastal Palm Beach`):

> REST OF TODAY (9/27)... Surf Height: **4 to 6 feet**.
> MONDAY (9/28)... Surf Height: **3 to 4 feet**.

(For comparison, the same product's Broward zone — where buoy 41122 actually
sits — said only 1–2 ft that day, confirming 41122's Hs reflects Broward's
Bahama-sheltered corridor, not Palm Beach's exposure. The formula below is
correcting for wave physics — Hs → breaking height — not for that
geographic gap; see SUMMARY.md in the backtest scratchpad for the
gap itself.)

| Date | NWS SRF surf | Period used | Hs avg | Period avg | Estimated surf (avg, range) | Fits? |
|---|---|---|---|---|---|---|
| 9/27 (full day) | 4–6 ft | DPD | 2.52 ft | 14.8 s | **4.80 ft** (3.60–5.97 ft) | **Yes** — lands in the middle of the range |
| 9/27 (full day) | 4–6 ft | APD | 2.52 ft | 7.4 s | 3.64 ft (2.31–5.01 ft) | No — undershoots, below the range |
| 9/28 (early UTC hours only*) | 3–4 ft | DPD | 1.60 ft | 14.0 s | **3.26 ft** (2.79–3.86 ft) | Yes — inside the range |
| 9/28 (early UTC hours only*) | 3–4 ft | APD | 1.60 ft | 6.8 s | 2.45 ft (2.00–2.97 ft) | No — undershoots, below the range |

\* The buoy fetch (2026-09-28 03:30Z) only reaches ~03:30Z Monday, i.e. the
tail of Sunday night ET, not true Monday daytime (that's still ahead in
local time). This row is a trend check on the declining swell, not a
same-clock-hour match — treat the 9/27 row as the primary swell-day anchor.

## Conclusion

**DPD looks like the better period, but this is a promising early
calibration, not a broadly validated one.** It lands inside or within ~0.5 ft
of both informal ground truths (the owner's direct observation and the
forecaster-issued SRF range) on the one swell event checked so far (9/27-28).
APD undershoots that same event's SRF ranges by 0.4–1.4 ft, which matches
NDBC's own documentation — DPD is the period at the spectrum's peak energy
(the swell), APD is a bulk average across the whole spectrum (swell +
chop) — but one event is one data point, not a validated conclusion.

**Caveats before trusting this further:**

- **Only one swell event checked.** Both anchors below come from the same
  9/27-28 swell (plus one calm day, 9/18, which barely exercises the
  amplification at all). A single event confirms the formula isn't obviously
  wrong; it doesn't confirm the formula generalizes.
- **The 9/27-28 "fit" mixes two different corrections.** The same NWS SRF
  product's Broward zone — where buoy 41122 actually sits — called only
  1–2 ft that day, a full 2–5 ft below the 4–6 ft called for Coastal Palm
  Beach (where Boca is). That gap is a ~25-mile EXPOSURE difference between
  two coastal zones, not a wave-physics effect at all. So the "the Palm Beach
  estimate lands in range" result is really the Hs→breaker-height
  transformation AND that unrelated geographic gap netting out to something
  that happens to look right — not clean evidence that the transformation
  alone is correctly calibrated.
- **Next step:** collect more anchors that are actually AT or near Boca/South
  Florida (SRF issued for the right zone, or a direct surf report), across
  more than one swell event, before treating DPD-vs-APD or the formula's
  magnitude as settled.

**Wired:** `lib/score.ts`'s `deriveMetrics` now converts Hs → estimated surf
height via `estimateSurfFromSources` (`lib/surfHeight.ts`), using the buoy's
own DPD when the buoy supplied the height, or the marine model's own TOTAL
dominant wave period when the model supplied it — falling back to the
model's SWELL height + SWELL period (matched to each other, never spliced
onto the total height) only when the model's total period is missing, and
never below the raw total Hs. Never cross-pairing a height from one reading
with a period from another.

## What Boca shows now (live, computed at doc time)

Latest 41122 reading: Hs 1.31 ft, DPD 14 s → estimated surf **2.8 ft**
(fallback-free; guard not triggered, clamp not triggered — 2.8 ft is within
[1.31, 3.28] ft). See `lib/surfHeight.ts` for the formula and
`docs/benchmarks/` conventions for reproducing this from a fresh buoy fetch.
