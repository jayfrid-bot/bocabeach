"use client";

import { useEffect, useState } from "react";

/**
 * TEMPORARY diagnostic banner — shows exactly what the runtime reports so we can
 * tell why native detection fails in the iOS shell (UA tag present? Capacitor
 * bridge injected? what platform?). Remove once push detection is confirmed.
 */
export function NativeDiag() {
  const [info, setInfo] = useState<string | null>(null);

  useEffect(() => {
    const w = window as unknown as {
      Capacitor?: { getPlatform?: () => string; isNativePlatform?: () => boolean };
      webkit?: { messageHandlers?: { bridge?: unknown } };
      androidBridge?: unknown;
    };
    const ua = navigator.userAgent;
    const tag = /IsItBeachDayApp/i.test(ua);
    const cap = typeof w.Capacitor !== "undefined";
    let plat = "n/a";
    try {
      plat = w.Capacitor?.getPlatform?.() ?? "n/a";
    } catch {
      plat = "err";
    }
    const bridge = !!w.webkit?.messageHandlers?.bridge;
    const andr = !!w.androidBridge;
    setInfo(
      `DIAG tag:${tag ? "Y" : "N"} cap:${cap ? "Y" : "N"} plat:${plat} ` +
        `iosBridge:${bridge ? "Y" : "N"} androidBridge:${andr ? "Y" : "N"} | ua:${ua.slice(-60)}`,
    );
  }, []);

  if (!info) return null;
  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        zIndex: 99999,
        background: "#111",
        color: "#22ff88",
        fontSize: "10px",
        lineHeight: "1.3",
        padding: "4px 6px",
        fontFamily: "ui-monospace, Menlo, monospace",
        wordBreak: "break-all",
      }}
    >
      {info}
    </div>
  );
}
