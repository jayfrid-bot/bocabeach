"use client";

import { useEffect } from "react";
import { flushPendingUnregister, isNativePlatform } from "@/lib/push/native";
import { readPendingUnregister } from "@/lib/plus/storage";

/**
 * Retry a turn-off that never reached the server (lib/push/native.ts), from the
 * whole app rather than only from the alerts button: on launch, when the phone
 * comes back online, and whenever the app returns to the foreground. Mount once
 * in the root layout. Cheap when nothing is queued (one local storage read).
 */
export function usePushQueueRetry(): void {
  useEffect(() => {
    const retry = () => {
      // Checked on every event, not once at mount: on the remote-URL shell the
      // native bridge can attach a beat after first paint.
      if (!isNativePlatform() || readPendingUnregister().length === 0) return;
      void flushPendingUnregister().catch(() => {});
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") retry();
    };
    retry();
    // The bridge may not be up yet at mount; look once more shortly after.
    const t = setTimeout(retry, 2000);
    window.addEventListener("online", retry);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearTimeout(t);
      window.removeEventListener("online", retry);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
}
