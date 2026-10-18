"use client";

import { useEffect } from "react";
import { isChunkLoadError, reloadIfChunkGone } from "@/lib/chunkReload";

/**
 * Last line for a build file that is gone (an old page after a deploy): any chunk error
 * that no import caught itself (an uncaught rejection or a failed script) goes to
 * lib/chunkReload.ts, which reloads once only when online and the server says the file is
 * gone. Every other error is left alone. Renders nothing.
 */
export function ChunkErrorReload() {
  useEffect(() => {
    const onRejection = (e: PromiseRejectionEvent) => {
      if (isChunkLoadError(e.reason)) void reloadIfChunkGone(e.reason);
    };
    const onError = (e: ErrorEvent) => {
      const err = e.error ?? e.message;
      if (isChunkLoadError(err)) void reloadIfChunkGone(err);
    };
    window.addEventListener("unhandledrejection", onRejection);
    window.addEventListener("error", onError);
    return () => {
      window.removeEventListener("unhandledrejection", onRejection);
      window.removeEventListener("error", onError);
    };
  }, []);
  return null;
}
