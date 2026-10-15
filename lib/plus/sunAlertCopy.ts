// Copy for the sunrise/sunset color feature that depends on whether the push
// alert is on (lib/plus/flags.ts SUN_ALERTS_UI_ENABLED). While the alert is
// off the app must not promise it: it says what the app does show, the color
// forecast an hour ahead (lib/sunForecastWindow.ts). Pure; each function takes
// the flag so both states are testable.

import { SUN_ALERTS_UI_ENABLED } from "@/lib/plus/flags";
import type { AlertKey } from "@/lib/db/types";

export interface PaywallBenefit {
  icon: string;
  title: string;
  body: string;
}

/** The subscribe screen's sunrise/sunset row. */
export function paywallSunBenefit(alertsOn: boolean = SUN_ALERTS_UI_ENABLED): PaywallBenefit {
  return alertsOn
    ? { icon: "🌅", title: "Sunrise and sunset alerts", body: "A heads-up when the sky is forecast to be colorful." }
    : {
        icon: "🌅",
        title: "Sunrise and sunset color, an hour ahead",
        body: "See how colorful the sky will be once we can see it.",
      };
}

/** The website's app card line about sunrise/sunset. */
export function inAppSunLine(alertsOn: boolean = SUN_ALERTS_UI_ENABLED): string {
  return alertsOn
    ? "A heads-up before a great sunrise or sunset"
    : "See how colorful tonight's sunset will be, an hour ahead";
}

/** The alert settings label for the sun-color key. */
export function sunColorAlertLabel(alertsOn: boolean = SUN_ALERTS_UI_ENABLED): string {
  return alertsOn ? "Great sunrise or sunset coming" : "Sunrise and sunset color";
}

/** Alert groups as the settings sheet shows them: the sun-color toggle is
 *  hidden while the alert is off. Stored prefs are never touched; this only
 *  filters what is drawn. A group left empty is dropped. */
export function visibleAlertGroups(
  groups: readonly { title: string; keys: AlertKey[] }[],
  alertsOn: boolean = SUN_ALERTS_UI_ENABLED,
): { title: string; keys: AlertKey[] }[] {
  return groups
    .map((g) => ({ title: g.title, keys: alertsOn ? g.keys : g.keys.filter((k) => k !== "sun-color") }))
    .filter((g) => g.keys.length > 0);
}
