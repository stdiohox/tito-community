"use server";

import { z } from "zod";
import { getViewer } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

// Real browser push services only. The server later POSTs to this URL, so
// anything else would be a server-side request forgery primitive. The
// database enforces the same list with a check constraint.
const PUSH_HOST = /^(fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|web\.push\.apple\.com|[a-z0-9-]+\.notify\.windows\.com)$/;

const subscriptionSchema = z.object({
  endpoint: z
    .url()
    .max(1000)
    .refine((u) => {
      const url = new URL(u);
      return url.protocol === "https:" && PUSH_HOST.test(url.hostname);
    }),
  keys: z.object({
    p256dh: z.string().min(1).max(200),
    auth: z.string().min(1).max(100),
  }),
});

/**
 * Registers this browser for the signed-in member through
 * claim_push_subscription(), which also takes the device over from anyone
 * who used it before. Fan-out still filters by access at send time, so a
 * lapsed member's device receives nothing.
 */
export async function savePushSubscription(raw: unknown): Promise<{ ok: boolean; error?: string }> {
  const viewer = await getViewer();
  if (!viewer) return { ok: false, error: "You are signed out." };
  const parsed = subscriptionSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "This browser's push service is not supported." };

  const supabase = await createClient();
  const { error } = await supabase.rpc("claim_push_subscription", {
    p_endpoint: parsed.data.endpoint,
    p_p256dh: parsed.data.keys.p256dh,
    p_auth: parsed.data.keys.auth,
  });
  if (error) {
    console.error(`[push] save failed: ${error.message}`);
    return { ok: false, error: "Could not save this device." };
  }
  return { ok: true };
}

export async function removePushSubscription(endpoint: string): Promise<{ ok: boolean }> {
  const viewer = await getViewer();
  if (!viewer) return { ok: false };
  const supabase = await createClient();
  const { error } = await supabase.from("push_subscriptions").delete().eq("endpoint", endpoint);
  if (error) {
    console.error(`[push] remove failed: ${error.message}`);
    return { ok: false };
  }
  return { ok: true };
}
