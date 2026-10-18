"use client";

import type { ConditionsResponse, LocationPublic } from "@/lib/types";
import type { PlusState } from "@/lib/plus/client";
import { Paywall } from "@/components/plus/Paywall";
import { PlusOnboarding } from "@/components/plus/PlusOnboarding";
import { PlusSettingsSheet } from "@/components/plus/PlusSettingsSheet";

export type PlusSheetName = "onboarding" | "paywall" | "settings";

/**
 * The three Plus screens (questions + reveal, paywall, settings). All three are
 * modal, all three are opened by a tap, and none renders anything until then —
 * so the dashboard loads this file (about 25 KB of script, plus the billing
 * code) only when a sheet is first opened, or when idle time in the app says it
 * soon will be. A default export so next/dynamic can split it.
 */
export default function PlusSheets({
  sheet,
  onClose,
  plus,
  res,
  nowMs,
  native,
  beaches,
  personalScore,
}: {
  sheet: PlusSheetName | null;
  onClose: () => void;
  plus: PlusState;
  res: ConditionsResponse;
  nowMs: number;
  native: boolean;
  beaches: LocationPublic[];
  personalScore: number | null;
}) {
  return (
    <>
      <PlusOnboarding
        open={sheet === "onboarding"}
        onClose={onClose}
        plus={plus}
        res={res}
        nowMs={nowMs}
        native={native}
      />
      <Paywall open={sheet === "paywall"} onClose={onClose} plus={plus} native={native} />
      <PlusSettingsSheet
        open={sheet === "settings"}
        onClose={onClose}
        plus={plus}
        beaches={beaches}
        native={native}
        personalScore={personalScore}
      />
    </>
  );
}
