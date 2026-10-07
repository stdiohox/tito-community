import "server-only";
import webpush from "web-push";
import { env } from "@/lib/env";
import { createServiceClient } from "@/lib/supabase/server";
import { layout, sendBatch, sendEmail } from "@/lib/email";

let vapidReady: boolean | null = null;

function pushConfigured(): boolean {
  if (vapidReady !== null) return vapidReady;
  const pub = env.vapidPublicKey();
  const priv = env.vapidPrivateKey();
  const subject = env.vapidSubject();
  vapidReady = Boolean(pub && priv && subject);
  if (vapidReady) webpush.setVapidDetails(subject!, pub!, priv!);
  return vapidReady;
}

/**
 * Tells members with live access that a new pick exists. TEASER ONLY: no
 * ticker, no prices, nothing a forwarded email or a lock-screen notification
 * could leak. Recipients come from active_member_recipients(), the same
 * predicate as has_access(), evaluated now.
 *
 * Idempotent: the notified_at claim means a pick is announced once, however
 * many times this runs.
 */
export async function notifyNewPick(pickId: string): Promise<{ push: number; email: number } | null> {
  const db = createServiceClient();

  const { data: claimed, error: claimError } = await db
    .from("picks")
    .update({ notified_at: new Date().toISOString() })
    .eq("id", pickId)
    .is("notified_at", null)
    .is("deleted_at", null)
    .select("id")
    .maybeSingle();
  if (claimError) throw new Error(`notify claim failed: ${claimError.message}`);
  if (!claimed) return null;

  const { data: recipients, error } = await db.rpc("active_member_recipients");
  if (error) throw new Error(`recipients failed: ${error.message}`);
  const people = (recipients ?? []) as { user_id: string; email: string }[];
  const url = `${env.siteUrl()}/picks/${pickId}`;

  let pushed = 0;
  if (!pushConfigured()) {
    console.warn("[push] VAPID keys not set; skipping push");
  } else if (people.length > 0) {
    const { data: subs } = await db
      .from("push_subscriptions")
      .select("id, endpoint, p256dh, auth")
      .in(
        "user_id",
        people.map((p) => p.user_id),
      );
    const payload = JSON.stringify({
      title: "New pick from Tito",
      body: "A new pick is waiting for you in the Circle.",
      url: `/picks/${pickId}`,
    });
    await Promise.all(
      (subs ?? []).map(async (s) => {
        try {
          await webpush.sendNotification(
            { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
            payload,
            { TTL: 60 * 60 * 12, urgency: "high" },
          );
          pushed++;
          await db.from("push_subscriptions").update({ last_success_at: new Date().toISOString() }).eq("id", s.id);
        } catch (e) {
          const status = (e as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410) {
            // The browser dropped this subscription; it will never work again.
            await db.from("push_subscriptions").delete().eq("id", s.id);
          } else {
            console.error(`[push] send failed (${status ?? "no status"})`);
          }
        }
      }),
    );
  }

  // Lapsed members keep no device registrations for long.
  const cutoff = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const keep = people.map((p) => p.user_id);
  let purge = db.from("push_subscriptions").delete().lt("created_at", cutoff);
  if (keep.length > 0) purge = purge.not("user_id", "in", `(${keep.join(",")})`);
  await purge;

  const emailed = await sendBatch(
    people.map((p) => ({
      to: p.email,
      subject: "A new pick is waiting in Tito Circle",
      text: `Tito has posted a new pick.\n\nOpen Tito Circle to read it: ${url}\n\nYou are receiving this because you are a member of Tito Circle.`,
      html: layout("A new pick is waiting", ["Tito has posted a new pick for members."], {
        label: "Open Tito Circle",
        url,
      }),
    })),
  );

  console.log(`[notify] pick ${pickId}: ${pushed} push, ${emailed} email, ${people.length} eligible`);
  return { push: pushed, email: emailed };
}

/**
 * Every publish alerts the admins immediately. A hijacked staff account
 * posting a fake pick is the attack this exists to catch, so this alert DOES
 * name the ticker: it goes to staff only.
 */
export async function alertAdminsOfPublish(summary: string, actorEmail: string): Promise<void> {
  const to = env.adminAlertEmails();
  if (to.length === 0) {
    console.warn("[alert] ADMIN_ALERT_EMAILS not set; publish alert not sent");
    return;
  }
  await Promise.all(
    to.map((address) =>
      sendEmail({
        to: address,
        subject: `Published in Tito Circle: ${summary}`,
        text: `${actorEmail} just published: ${summary}\n\nIf this was not you or your team, revoke staff access and rotate credentials now.`,
        html: layout("Something was just published", [
          `${actorEmail} just published: ${summary}.`,
          "If this was not you or your team, revoke staff access and rotate credentials now.",
        ]),
      }),
    ),
  );
}
