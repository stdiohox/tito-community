"use client";

import { useEffect, useId, useState } from "react";
import { removePushSubscription, savePushSubscription } from "@/app/push/actions";

type Status = "loading" | "unsupported" | "ios-install" | "denied" | "off" | "on" | "busy" | "unconfigured";

function urlBase64ToUint8Array(base64: string) {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

/** serviceWorker.ready never settles if registration failed; give up after a while. */
function swReady(ms = 8000): Promise<ServiceWorkerRegistration> {
  return Promise.race([
    navigator.serviceWorker.ready,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("service worker not ready")), ms)),
  ]);
}

/**
 * Pick alerts on this device. On iPhone, web push only works once the app is
 * added to the Home Screen, so the toggle explains that instead of failing.
 */
export function PushToggle({ vapidPublicKey }: { vapidPublicKey: string | null }) {
  const [status, setStatus] = useState<Status>("loading");
  const [error, setError] = useState<string | null>(null);
  const [announce, setAnnounce] = useState("");
  const labelId = useId();
  const hintId = useId();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!vapidPublicKey) return setStatus("unconfigured");
      const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
      const standalone = window.matchMedia("(display-mode: standalone)").matches;
      if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
        return setStatus(ios && !standalone ? "ios-install" : "unsupported");
      }
      if (Notification.permission === "denied") return setStatus("denied");
      const reg = await swReady();
      const sub = await reg.pushManager.getSubscription();
      if (!cancelled) setStatus(sub ? "on" : "off");
    })().catch(() => {
      if (!cancelled) setStatus("unsupported");
    });
    return () => {
      cancelled = true;
    };
  }, [vapidPublicKey]);

  async function enable() {
    setError(null);
    setStatus("busy");
    let sub: PushSubscription | null = null;
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") return setStatus(permission === "denied" ? "denied" : "off");
      const reg = await swReady();
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidPublicKey!),
      });
      const res = await savePushSubscription(sub.toJSON());
      if (!res.ok) throw new Error(res.error ?? "Could not turn on alerts.");
      setStatus("on");
      setAnnounce("Pick alerts are on for this device.");
    } catch (e) {
      // Never leave the browser subscribed when the server has no record.
      await sub?.unsubscribe().catch(() => undefined);
      setError(e instanceof Error && e.message ? e.message : "Could not turn on alerts in this browser.");
      setStatus("off");
    }
  }

  async function disable() {
    setError(null);
    setStatus("busy");
    try {
      const reg = await swReady();
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        const res = await removePushSubscription(sub.endpoint);
        if (!res.ok) throw new Error("Could not turn off alerts. Try again.");
        await sub.unsubscribe();
      }
      setStatus("off");
      setAnnounce("Pick alerts are off for this device.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not turn off alerts.");
      setStatus("on");
    }
  }

  if (status === "loading" || status === "unconfigured" || status === "unsupported") return null;

  const busy = status === "busy";
  return (
    <div className="flex items-center justify-between gap-4 rounded-2xl border border-line bg-paper px-4 py-3">
      <div className="min-w-0">
        <p id={labelId} className="text-sm font-medium text-ink">
          Pick alerts on this device
        </p>
        <p id={hintId} className="text-xs leading-relaxed text-muted">
          {status === "ios-install"
            ? "On iPhone: tap Share, then Add to Home Screen, then open Tito Circle from there to turn alerts on."
            : status === "denied"
              ? "Notifications are blocked for this site in your browser settings."
              : status === "on"
                ? "You'll get a notification when Tito posts a pick."
                : "Get a notification the moment Tito posts a pick."}
        </p>
        {error ? (
          <p role="alert" className="mt-1 text-xs text-danger">
            {error}
          </p>
        ) : null}
        <p role="status" aria-live="polite" className="sr-only">
          {announce}
        </p>
      </div>
      {status === "on" || status === "off" || busy ? (
        <button
          type="button"
          role="switch"
          aria-checked={status === "on"}
          aria-labelledby={labelId}
          aria-describedby={hintId}
          aria-disabled={busy}
          aria-busy={busy}
          onClick={busy ? undefined : status === "on" ? disable : enable}
          className={`relative h-8 w-14 shrink-0 rounded-full transition-colors duration-200 ${busy ? "opacity-60" : ""} ${status === "on" ? "bg-forest" : "bg-control"}`}
        >
          <span
            aria-hidden
            className={`absolute left-1 top-1 flex size-6 items-center justify-center rounded-full bg-paper text-[10px] font-semibold shadow transition-transform duration-200 ease-[var(--ease-out-expo)] ${status === "on" ? "translate-x-6 text-forest" : "text-muted"}`}
          >
            {status === "on" ? "✓" : ""}
          </span>
        </button>
      ) : null}
    </div>
  );
}
