// ---------------------------------------------------------------------------
// Static yearly calendar of the 7 major meteor showers (SKY_EVENTS_PLAN.md
// §6, Phase 1 Crew A). No live API — this table is hand-maintained, one
// entry per shower per supported year, and always needs the CURRENT and
// NEXT calendar year present (config/meteorShowers.test.ts's
// "current + next year" check fails the build otherwise, mirroring the
// king-tide feed's current+next-station-year rule, §3).
//
// SOURCES — what this file is actually built from, and why (2026-09-28):
//
// The plan's two named free/public sources are the IMO Meteor Shower
// Calendar (imo.net/resources/calendar) and the American Meteor Society's
// calendar (amsmeteors.org/meteor-showers/meteor-shower-calendar/). Live
// verification attempted 2026-09-28:
//   - imo.net/files/meteor-shower/cal2026.pdf, cal2027.pdf, AND the site's
//     own advertised replacement link (./ShCal27s.pdf) all resolved to
//     imo.net's own "website restoration" placeholder page ("We're
//     rebuilding... Some parts of the website will remain unavailable") —
//     the PDF calendar itself is not currently reachable.
//   - web.archive.org is blocked for this build's fetch tool, and
//     archive.org's own API separately reported "temporarily offline" when
//     tried directly; a ResearchGate mirror of the 2026 IMO calendar
//     returned HTTP 403.
//   - amsmeteors.org/meteor-showers/meteor-shower-calendar/ WAS reachable
//     live and is the source for every ACTIVITY WINDOW and PEAK DATE (day
//     granularity) below, cross-checked against Wikipedia's "List of meteor
//     showers" (en.wikipedia.org/wiki/List_of_meteor_showers, itself sourced
//     to IMO's working list) for RADIANT (RA/Dec), ZHR, and velocity —
//     both fetched live 2026-09-28 and mutually consistent on every shower's
//     peak day and activity window.
//
// Neither reachable source publishes an exact peak CLOCK TIME (AMS gives
// day-level dates like "Aug 12-13"; only Quadrantids 2027 had a specific
// time quoted anywhere found: "near 3:30 UT on January 4"). Since a shower's
// maximum is, by definition, the moment Earth crosses a fixed point in its
// orbit (the shower's reference SOLAR LONGITUDE, not a fixed calendar time),
// this file computes each `peak` instant by solving for when the Sun's
// apparent ecliptic longitude crosses that shower's reference solar
// longitude — the same NOAA solar-position formulas lib/sources/sun.ts
// already uses for sunrise/sunset, generalized here to an arbitrary instant
// and inverted (solve-for-time instead of solve-for-altitude). Reference
// solar longitudes (J2000 equinox, degrees) are the long-standing IMO
// "Working List of Visual Meteor Showers" values, precession-adjusted
// (+0.0139697 deg/year) to each target year. Cross-check: this method gives
// Quadrantids 2027 = 2027-01-04T03:40Z, 10 minutes from AMS's quoted
// "near 3:30 UT" — treat every `peak` below as accurate to roughly
// ±20-30 minutes, not to the second, until the IMO PDF is reachable again
// and these can be replaced with literally-transcribed values (re-run the
// live checks above first).
//
// `radiantRaDeg`/`radiantDecDeg`/`zhr` are each shower's value AT PEAK, not
// drift-corrected across the multi-week activity window (a stated v1
// simplification — some showers' radiants drift a degree or more over their
// activity window; peak-time drift is what SKY_EVENTS_PLAN.md §6's
// "radiant above horizon" check needs most, since that's also when
// lib/sources/meteorShowers.ts's bestLocalWindow search centers).
//
// Activity windows are half-open UTC `[start, end)` at day boundaries
// (00:00Z), covering the LAST active calendar day fully (end = the day
// after the source's stated last active date). Quadrantids' window
// deliberately starts in the PRIOR Gregorian year (activity begins
// "Dec 28") — this is the year-rollover case
// lib/sources/meteorShowers.test.ts exercises explicitly.

import type { IsoInstant, IsoInterval } from "@/lib/skyEventsTypes";

/** One shower's data for one apparition (peak year = the calendar year its
 *  PEAK falls in, which is how this table is keyed — Quadrantids' activity
 *  window starts the prior December, but it's filed under the January
 *  year). */
export interface MeteorShowerYearPeak {
  year: number;
  peak: IsoInstant;
  activityWindow: IsoInterval;
  /** Where THIS year's numbers were transcribed from (§6) — see the file
   *  header for the full methodology; kept short and per-entry so a future
   *  re-verification pass can update one year at a time. */
  sourceEdition: string;
}

export interface MeteorShowerDefinition {
  showerId: string;
  showerName: string;
  /** Radiant right ascension, degrees (0-360), at peak. */
  radiantRaDeg: number;
  /** Radiant declination, degrees (-90..90), at peak. */
  radiantDecDeg: number;
  /** Zenithal Hourly Rate at peak, under ideal conditions. */
  zhr: number;
  /** One entry per supported year, current-year-and-next-year at minimum
   *  (config/meteorShowers.test.ts enforces this). A year this table
   *  doesn't carry is simply unavailable for that shower — never
   *  extrapolated (§6). */
  peaks: readonly MeteorShowerYearPeak[];
}

const AMS_2026_09_28 =
  "AMS Meteor Shower Calendar (amsmeteors.org/meteor-showers/meteor-shower-calendar/), fetched 2026-09-28; radiant/ZHR cross-checked against Wikipedia's List of meteor showers (fetched 2026-09-28); peak clock time computed via solar-longitude crossing — IMO PDF unreachable at build time, see file header";

export const METEOR_SHOWERS: readonly MeteorShowerDefinition[] = [
  {
    showerId: "quadrantids",
    showerName: "Quadrantids",
    radiantRaDeg: 229.5, // 15.3h
    radiantDecDeg: 49,
    zhr: 80,
    peaks: [
      {
        year: 2026,
        peak: "2026-01-03T21:33:00Z",
        activityWindow: { start: "2025-12-28T00:00:00Z", end: "2026-01-13T00:00:00Z" },
        sourceEdition: AMS_2026_09_28,
      },
      {
        year: 2027,
        peak: "2027-01-04T03:40:00Z",
        activityWindow: { start: "2026-12-28T00:00:00Z", end: "2027-01-13T00:00:00Z" },
        sourceEdition: AMS_2026_09_28,
      },
    ],
  },
  {
    showerId: "lyrids",
    showerName: "Lyrids",
    radiantRaDeg: 271.5, // 18.1h
    radiantDecDeg: 34,
    zhr: 18,
    peaks: [
      {
        year: 2026,
        peak: "2026-04-22T19:29:00Z",
        activityWindow: { start: "2026-04-14T00:00:00Z", end: "2026-05-01T00:00:00Z" },
        sourceEdition: AMS_2026_09_28,
      },
      {
        year: 2027,
        peak: "2027-04-23T01:36:00Z",
        activityWindow: { start: "2027-04-14T00:00:00Z", end: "2027-05-01T00:00:00Z" },
        sourceEdition: AMS_2026_09_28,
      },
    ],
  },
  {
    showerId: "eta-aquariids",
    showerName: "Eta Aquariids",
    radiantRaDeg: 337.5, // 22.5h
    radiantDecDeg: -1,
    zhr: 50,
    peaks: [
      {
        year: 2026,
        peak: "2026-05-06T09:00:00Z",
        activityWindow: { start: "2026-04-19T00:00:00Z", end: "2026-05-29T00:00:00Z" },
        sourceEdition: AMS_2026_09_28,
      },
      {
        year: 2027,
        peak: "2027-05-06T15:07:00Z",
        activityWindow: { start: "2027-04-19T00:00:00Z", end: "2027-05-29T00:00:00Z" },
        sourceEdition: AMS_2026_09_28,
      },
    ],
  },
  {
    showerId: "perseids",
    showerName: "Perseids",
    radiantRaDeg: 48.0, // 3.2h
    radiantDecDeg: 58,
    zhr: 100,
    peaks: [
      {
        year: 2026,
        peak: "2026-08-13T01:53:00Z",
        activityWindow: { start: "2026-07-17T00:00:00Z", end: "2026-08-25T00:00:00Z" },
        sourceEdition: AMS_2026_09_28,
      },
      {
        year: 2027,
        peak: "2027-08-13T08:00:00Z",
        activityWindow: { start: "2027-07-17T00:00:00Z", end: "2027-08-25T00:00:00Z" },
        sourceEdition: AMS_2026_09_28,
      },
    ],
  },
  {
    showerId: "orionids",
    showerName: "Orionids",
    radiantRaDeg: 94.5, // 6.3h
    radiantDecDeg: 16,
    zhr: 20,
    peaks: [
      {
        year: 2026,
        peak: "2026-10-22T03:51:00Z",
        activityWindow: { start: "2026-10-02T00:00:00Z", end: "2026-11-08T00:00:00Z" },
        sourceEdition: AMS_2026_09_28,
      },
      {
        year: 2027,
        peak: "2027-10-22T09:58:00Z",
        activityWindow: { start: "2027-10-02T00:00:00Z", end: "2027-11-08T00:00:00Z" },
        sourceEdition: AMS_2026_09_28,
      },
    ],
  },
  {
    showerId: "leonids",
    showerName: "Leonids",
    radiantRaDeg: 151.5, // 10.1h
    radiantDecDeg: 22,
    zhr: 15,
    peaks: [
      {
        year: 2026,
        peak: "2026-11-17T23:33:00Z",
        activityWindow: { start: "2026-11-06T00:00:00Z", end: "2026-12-01T00:00:00Z" },
        sourceEdition: AMS_2026_09_28,
      },
      {
        year: 2027,
        peak: "2027-11-18T05:41:00Z",
        activityWindow: { start: "2027-11-06T00:00:00Z", end: "2027-12-01T00:00:00Z" },
        sourceEdition: AMS_2026_09_28,
      },
    ],
  },
  {
    showerId: "geminids",
    showerName: "Geminids",
    radiantRaDeg: 112.5, // 7.5h
    radiantDecDeg: 33,
    zhr: 150,
    peaks: [
      {
        year: 2026,
        peak: "2026-12-14T13:27:00Z",
        activityWindow: { start: "2026-12-04T00:00:00Z", end: "2026-12-21T00:00:00Z" },
        sourceEdition: AMS_2026_09_28,
      },
      {
        year: 2027,
        peak: "2027-12-14T19:35:00Z",
        activityWindow: { start: "2027-12-04T00:00:00Z", end: "2027-12-21T00:00:00Z" },
        sourceEdition: AMS_2026_09_28,
      },
    ],
  },
] as const;
