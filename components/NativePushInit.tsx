"use client";

import { useEffect } from "react";
import { initNativeTapHandling } from "@/lib/push/native";

/**
 * App-wide native push wiring: registers the tap handler so tapping a delivered
 * iOS notification opens its beach. No-op in any browser (guarded by
 * isNativePlatform inside initNativeTapHandling).
 */
export function NativePushInit() {
  useEffect(() => {
    void initNativeTapHandling();
  }, []);
  return null;
}
