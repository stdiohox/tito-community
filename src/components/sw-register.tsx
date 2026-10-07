"use client";

import { useEffect } from "react";

/** Registers the service worker that powers install, offline and push. */
export function SwRegister() {
  useEffect(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" }).catch((e) => {
        console.error("Service worker registration failed", e);
      });
    }
  }, []);
  return null;
}
