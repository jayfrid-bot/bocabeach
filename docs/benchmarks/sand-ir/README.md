# Sand temperature: IR ground truth

`readings.csv` holds every infrared-thermometer reading of beach sand that the owner took, next to the sand model's inputs and its estimate at that moment.

- `measured_*` are the owner's IR readings in °F. `mid` is the middle of the range he reported.
- `spot` says where on the beach: `dunes` / `dry sand` is loose dry sand, `surf` is firm damp sand near the water. The model gives both ends (its range card).
- `model_f` is the model's dry-sand estimate at that moment, when it is known.
- Rows from June to September were recovered from the calibration notes in `lib/sandTemp.ts`. Rows from 2026-10-06 on also have the model inputs archived hourly in `beach_hourly.extra_json` (`sand` block).

Add a row for every new field reading, with the spot. Retune the model only when several readings at the same kind of spot agree. Single readings vary by up to ±7°F between nearby spots (2026-09-02: six readings, 121–135°F).

## Bench

`scripts/sand_backtest.ts` re-scores every reading with the live model and a set of candidate changes (`npx vite-node -c vitest.config.ts scripts/sand_backtest.ts`). `hourly-forecast.json` and `satellite.json` are the Open-Meteo archives it reads (Boca, 2026-06-01 to 2026-10-06; refetch and extend the end date when new readings are added). Results and verdicts are dated files in this folder, newest: `backtest-2026-10-06.md`.
