# Spanish version: inventory and decision (2026-09-30)

The owner asked for a Spanish version, then asked if it is worth it. The answer on 2026-09-30 was "not yet". These files keep the research so a later attempt does not repeat it.

## Decision

Wait. The limit on growth is finding users, not language.

- Scale that day: about 3 daily and 18 weekly app users, about 4 installs a week, about 257 web visits a week (99% US, about 7 from search engines).
- Beach apps in the US App Store that already have Spanish have almost no ratings (iPlaya 3, Playa Now 0, Mareas 0, Costa: Playas de Puerto Rico 29).
- App Store autocomplete shows some Spanish demand for "sargazo", "mareas", "tabla de mareas" and "playa". It shows none for "clima playa" or "bandera playa".

Cheap tests offered in place of a translation:

1. A Spanish (Mexico) App Store listing. The US store also indexes its keywords. The listing must say that the app is in English.
2. Record the phone's two-letter language in the daily `/api/open` ping, to measure the real share.

Look again when Spanish phones reach about 15% of users, or when Puerto Rico beaches are added.

## Size of the work

| Area | Report | Size |
|---|---|---|
| Text built in `lib/` and the conditions payload | [01-server-text.md](01-server-text.md) | about 470 strings, plus `nerdInfo` (about 220) and the changelog (122 entries) |
| Screens and pages | [02-components.md](02-components.md) | about 923 strings in 79 files, about 6,700 words |
| Push, Live Activity, iPhone shell | [03-push-native.md](03-push-native.md) | about 70 push strings, about 35 Swift phrases, about 10 other native strings |

## Traps to read before any translation work

- Score-cap strings have no codes. Their English text is their identity, and 45 code sites match on English wording (`lib/score.ts`, `lib/explain.ts`, `components/ScoreCapBanner.tsx`, the history dedupe). Translate at the display layer, or give caps codes first.
- `lib/score.ts` matches the English text of our own weather labels on the hourly path. A translation at the source changes hourly scores.
- The conditions pipeline has no locale. `/api/conditions` returns 400 for any new query string, and the cache keys carry no locale.
- 36 of the 53 `en-US` / `en-CA` format calls are machine formats (date keys, NWS windows). Do not localize them.
- About 40 e2e selectors depend on English text.
- Push copy is built for each device, so a `devices.locale` column would work. The shared morning summary cache holds English text, and `listArmed` must select the new column.
- The Live Activity widget has no localization set up. Spanish there needs a new App Store build.

The line numbers in the reports are from commit 9cd2df6.
