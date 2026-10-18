"use client";

import { useEffect } from "react";
import { isChunkLoadError, reloadOnceForChunkError } from "@/lib/chunkReload";

/**
 * Last line for a build file that is gone (an old page after a deploy): any chunk error
 * that no import caught itself (an uncaught rejection or a failed script) starts the one
 * guarded reload in lib/chunkReload.ts. Every other error is left alone. Renders nothing.
 */
export function ChunkErrorReload() {
  useEffect(() => {
    const onRejection = (e: PromiseRejectionEvent) => {
      if (isChunkLoadError(e.reason)) reloadOnceForChunkError(e.reason);
    };
    const onError = (e: ErrorEvent) => {
      const err = e.error ?? e.message;
      if (isChunkLoadError(err)) reloadOnceForChunkError(err);
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
