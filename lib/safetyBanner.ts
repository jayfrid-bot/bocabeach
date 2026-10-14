// The safety banner's model, as a pure function: which hazards exist, what each
// says, how they rank, and how loud the whole banner is. BOTH the website
// (components/SafetyBanner.tsx renders this) and the Apple Watch view
// (lib/watchView.ts maps this to short lines) call it, so the wrist can never
// say something the page does not, or rank things differently.
//
// Everything here used to live inside SafetyBanner.tsx. The policy pieces are
// unchanged and still come from their own tested modules:
//   tone ................ lib/safetyTone.ts
//   rank ................ lib/safetyBannerRank.ts
//   rip resolution ...... lib/ripRisk (resolveRipNow, ripCopy)
//   alert in-effect ..... lib/ripRisk/resolve.ts (isAlertInEffectAt/UpcomingAt)
// Each candidate also carries a `short` text and a `tone` for small screens;
// the website ignores those two fields.

import type {
  CityOfficialData,
  FlagColor,
  LightningData,
  NwsAlert,
  NwsData,
  RipNwpsBeachSeries,
  WaterQualityData,
  Wrapped,
} from "@/lib/types";
import { resolveRipNow } from "@/lib/ripRisk";
import { isAlertInEffectAt, isAlertUpcomingAt } from "@/lib/ripRisk/resolve";
import { isRipAlertEvent, type RipNow } from "@/lib/ripRisk/types";
import { ripCopy, type RipCopy } from "@/lib/ripRisk/copy";
import { safetyTone, type SafetyTone } from "@/lib/safetyTone";
import { isWarningTierAlert, rankSafetyItems, type SafetyItem } from "@/lib/safetyBannerRank";
import { modelNowFromSeries } from "@/lib/sources/ripNwps";
import type { RainNowcast } from "@/lib/rainNowcast";

/** Plain labels for the compact headline only; the flags row still renders swatches. */
export const FLAG_HEADLINE: Record<string, string> = {
  "double-red": "Double red flag — water access closed",
  red: "Red flag — high hazard",
  purple: "Purple flag — dangerous marine life",
  yellow: "Yellow flag — medium hazard",
  green: "Green flag — low hazard",
};

export interface BannerItem extends SafetyItem {
  /** A few words, for a watch. */
  short: string;
  /** How loud this one item is (the whole banner's tone is `tone` on the model). */
  itemTone: SafetyTone;
}

export interface SafetyBannerInput {
  city: Wrapped<CityOfficialData>;
  water?: Wrapped<WaterQualityData>;
  lightning?: Wrapped<LightningData>;
  nws?: Wrapped<NwsData>;
  ripNwps?: Wrapped<RipNwpsBeachSeries>;
  timezone?: string;
  nowMs: number;
  /** Rain on the radar, worded by lib/rainNowcast.ts. The website shows this in
   *  its own chip, not in the banner, so SafetyBanner does not pass it; the
   *  watch has no chip and passes it so rain ranks with everything else. */
  rain?: RainNowcast | null;
}

export interface SafetyBannerModel {
  /** Nothing worth a banner: the website renders nothing. */
  hidden: boolean;
  tone: SafetyTone;
  /** Every candidate, worst first (lib/safetyBannerRank.ts). */
  items: BannerItem[];
  headline: BannerItem | null;
  rest: BannerItem[];
  /** The line under the headline: the next item's text, "+N more" when there are several. */
  otherLabel: string | null;

  flags: FlagColor[];
  advisory: boolean;
  lightningDanger: boolean;
  noSwim: { title: string; url: string } | undefined;
  lightningData: LightningData | null | undefined;
  ripNow: RipNow;
  ripBannerCopy: RipCopy;
  hasRipToShow: boolean;
  activeNonRipAlerts: NwsAlert[];
  upcomingNonRipAlerts: NwsAlert[];
  beachHazards: NwsAlert[];
  otherAlerts: NwsAlert[];
}

function itemTone(item: SafetyItem): SafetyTone {
  switch (item.kind) {
    case "lightning":
    case "warningAlert":
    case "closure":
    case "redFlagOrRipWarning":
      return "danger";
    case "softAdvisory":
      return "caution";
    default:
      // "other": the calmer flags and upcoming products.
      return item.id === "flag-yellow" || item.id === "flag-purple" ? "caution" : "calm";
  }
}

export function buildSafetyBanner(input: SafetyBannerInput): SafetyBannerModel {
  const { city, water, lightning, nws, ripNwps, nowMs, rain } = input;
  const timezone = input.timezone ?? "America/New_York";
  const data = city.data;
  const wq = water?.data;
  const advisory = wq?.advisory ?? false;
  const lt = lightning?.data;
  // A strike within 5 mi during the scanned window -> get out of the water. Gate
  // on a fresh "ok" snapshot so a stale feed never shows the red block.
  const lightningDanger =
    (lt?.nearestMi ?? Infinity) <= 5 &&
    lightning?.status === "ok" &&
    (lt?.lastMinutesAgo == null || lt.lastMinutesAgo <= 30);
  const noSwim = data?.noSwimAdvisory;
  const alerts = nws?.data?.alerts ?? [];
  // Temporally-resolved rip status: an alert in effect (always High) > a fresh
  // NOAA model reading > the current SRF word > unknown.
  const ripNow = resolveRipNow({
    alerts,
    srfPeriods: nws?.data?.srfPeriods,
    model: modelNowFromSeries(ripNwps?.data ?? null, nowMs),
    now: nowMs,
  });
  // Rip statements get their own block (isRipAlertEvent); everything else is a
  // generic alert, active or upcoming, resolved against the same clock.
  const nonRipAlerts = alerts.filter((a) => !isRipAlertEvent(a));
  const activeNonRipAlerts = nonRipAlerts.filter((a) => isAlertInEffectAt(a, nowMs));
  const upcomingNonRipAlerts = nonRipAlerts.filter((a) => isAlertUpcomingAt(a, nowMs));
  const beachHazards = activeNonRipAlerts.filter((a) => /beach hazard/i.test(a.event));
  const otherAlerts = activeNonRipAlerts.filter((a) => !/beach hazard/i.test(a.event));
  const flags = data?.flags.filter((f) => f !== "unknown") ?? [];
  const tone = safetyTone({
    advisory,
    lightningDanger,
    noSwim: !!noSwim,
    ripNow,
    flags,
    alertEvents: activeNonRipAlerts.map((a) => a.event),
  });

  const ripBannerCopy = ripCopy(ripNow, ripNwps?.data?.hours ?? null, nowMs, timezone);

  // A resolved "low" from the model/forecast with nothing upcoming is not worth
  // a block; only an in-effect alert, a moderate/high reading, or a scheduled
  // future alert earns one.
  const hasRipToShow =
    ripNow.source === "alert" ||
    ((ripNow.source === "model" || ripNow.source === "forecast") && ripNow.level !== "low") ||
    ripNow.upcomingAlert != null;

  const hidden =
    !advisory &&
    !lightningDanger &&
    !noSwim &&
    !hasRipToShow &&
    activeNonRipAlerts.length === 0 &&
    upcomingNonRipAlerts.length === 0 &&
    flags.length === 0;

  // One candidate per hazard SOURCE, never batched.
  const candidates: (SafetyItem & { short: string })[] = [];
  if (lightningDanger) {
    const mi = lt?.nearestMi;
    candidates.push({
      kind: "lightning",
      icon: "⛈️",
      text: "Lightning nearby — get out of the water and seek shelter",
      short: typeof mi === "number" && Number.isFinite(mi) ? `Lightning ${mi} mi away` : "Lightning nearby",
      id: "lightning",
    });
  }
  for (const a of activeNonRipAlerts) {
    candidates.push({
      kind: isWarningTierAlert(a) ? "warningAlert" : "softAdvisory",
      icon: /beach hazard/i.test(a.event) ? "🚩" : "⚠️",
      // The plain product name, not the long CAP headline.
      text: a.event,
      short: a.event,
      id: `alert:${a.event}:${a.ends ?? ""}`,
    });
  }
  if (advisory) {
    candidates.push({
      kind: "closure",
      icon: "🧫",
      text: "Water quality advisory — swimming not recommended",
      short: "Water quality advisory",
      id: "wq-advisory",
    });
  }
  if (noSwim) {
    candidates.push({ kind: "closure", icon: "🚫", text: noSwim.title, short: noSwim.title, id: "no-swim" });
  }
  if (flags.includes("double-red")) {
    candidates.push({ kind: "closure", icon: "🚩", text: FLAG_HEADLINE["double-red"], short: "Double red flag", id: "flag-double-red" });
  }
  if (flags.includes("red")) {
    candidates.push({ kind: "redFlagOrRipWarning", icon: "🚩", text: FLAG_HEADLINE.red, short: "Red flag", id: "flag-red" });
  }
  if (hasRipToShow) {
    // An actual NWS Rip Current Statement/Warning in effect ranks with the red
    // flag; a model/forecast reading is guidance, a softer tier.
    candidates.push({
      kind: ripNow.source === "alert" ? "redFlagOrRipWarning" : "softAdvisory",
      icon: "🌊",
      text: ripBannerCopy.bannerText,
      short:
        ripNow.source === "alert"
          ? "Rip current alert"
          : ripNow.level === "unknown"
            ? "Rip current alert soon"
            : `Rip current ${ripNow.level}`,
      id: "rip",
    });
  }
  if (rain) {
    candidates.push({
      kind: rain.kind === "nearby" ? "other" : "softAdvisory",
      icon: "🌧️",
      text: rain.text,
      short:
        rain.kind === "raining"
          ? "Raining now"
          : rain.kind === "approaching" && rain.etaMinutes != null
            ? `Rain in ~${rain.etaMinutes} min`
            : rain.text,
      id: "rain",
    });
  }
  if (upcomingNonRipAlerts.length) {
    const first = upcomingNonRipAlerts[0].event;
    candidates.push({
      kind: "other",
      icon: "🕐",
      text: `${first} begins soon${
        upcomingNonRipAlerts.length > 1 ? ` (+${upcomingNonRipAlerts.length - 1} more)` : ""
      }`,
      short: `${first} soon`,
      id: "upcoming",
    });
  }
  if (flags.includes("purple")) {
    candidates.push({ kind: "other", icon: "🚩", text: FLAG_HEADLINE.purple, short: "Purple flag", id: "flag-purple" });
  }
  if (flags.includes("yellow")) {
    candidates.push({ kind: "other", icon: "🚩", text: FLAG_HEADLINE.yellow, short: "Yellow flag", id: "flag-yellow" });
  }
  if (flags.includes("green")) {
    candidates.push({ kind: "other", icon: "🚩", text: FLAG_HEADLINE.green, short: "Green flag", id: "flag-green" });
  }

  const items: BannerItem[] = rankSafetyItems(candidates).map((c) => ({ ...c, itemTone: itemTone(c) }));
  const headline = items[0] ?? null;
  const rest = items.slice(1);
  // Flags always render as their own swatches beside this label, so they stay
  // out of the text count.
  const restText = rest.filter((r) => !r.id.startsWith("flag-"));
  const otherLabel =
    restText.length === 0
      ? null
      : restText.length === 1
        ? restText[0].text
        : `${restText[0].text} +${restText.length - 1} more`;

  return {
    hidden,
    tone,
    items,
    headline,
    rest,
    otherLabel,
    flags,
    advisory,
    lightningDanger,
    noSwim,
    lightningData: lt,
    ripNow,
    ripBannerCopy,
    hasRipToShow,
    activeNonRipAlerts,
    upcomingNonRipAlerts,
    beachHazards,
    otherAlerts,
  };
}
