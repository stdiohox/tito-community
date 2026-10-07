import "server-only";
import webpush from "web-push";
import { env } from "@/lib/env";
import { createServiceClient } from "@/lib/supabase/server";
import { layout, sendEmail, sendIdempotent, type SendOutcome } from "@/lib/email";

/*
 * PICK ALERTS ARE A QUEUE, NOT A LOOP.
 *
 * Publishing a pick enqueues one notification_deliveries row per email and
 * per device (enqueue_pick_notifications). Workers then drain the queue:
 * claim a batch (locked for LOCK_SECONDS), send each, record each outcome.
 *
 * Nothing is lost to a crash: a row is only "sent" once its send succeeded
 * and was recorded. If a worker dies holding a batch, the lock lapses and
 * the next drain (the cron every five minutes, the next publish, or "Send
 * pending alerts now" in the admin) claims those rows again.
 *
 * Nothing is sent twice by email: each row's id is its Resend idempotency
 * key, so a retried row cannot produce a second email. A retried push can
 * repeat at worst; every alert shares one notification tag, so a repeat
 * replaces the earlier notification on the device instead of stacking.
 *
 * TEASER ONLY: no ticker, no prices, nothing a forwarded email or a
 * lock-screen notification could leak. Eligibility (access right now) is
 * re-checked when each row is claimed, not frozen at publish time.
 */

export const LOCK_SECONDS = 300;
export const MAX_ATTEMPTS = 5;
const BATCH_SIZE = 25;
const CONCURRENCY = 5;
const PUSH_TIMEOUT_MS = 10_000;

export type Delivery = {
  id: string;
  pick_id: string;
  user_id: string;
  channel: "push" | "email";
  push_subscription_id: string | null;
  /** The claim token: completing the row requires the same number back. */
  attempts: number;
  email: string | null;
  endpoint: string | null;
  p256dh: string | null;
  auth: string | null;
};

export type PushOutcome = SendOutcome | { ok: false; gone: true; error: string };

/** How each channel actually sends. Injected in tests. */
export type Senders = {
  push(d: Delivery, payload: string): Promise<PushOutcome>;
  email(d: Delivery, url: string): Promise<SendOutcome>;
};

let vapidReady: boolean | null = null;

function pushConfigured(): boolean {
  if (vapidReady !== null) return vapidReady;
  const pub = env.vapidPublicKey();
  const priv = env.vapidPrivateKey();
  const subject = env.vapidSubject();
  vapidReady = false;
  if (pub && priv && subject) {
    try {
      webpush.setVapidDetails(subject, pub, priv);
      vapidReady = true;
    } catch (e) {
      // A malformed key is a configuration error: fail those sends clearly
      // (as permanent) instead of retrying them forever.
      console.error(`[push] VAPID keys rejected: ${e instanceof Error ? e.message : e}`);
    }
  }
  return vapidReady;
}

const defaultSenders: Senders = {
  async push(d, payload) {
    if (!pushConfigured()) {
      return { ok: false, permanent: true, error: "Push is not configured (VAPID keys)" };
    }
    if (!d.endpoint || !d.p256dh || !d.auth) {
      return { ok: false, permanent: true, error: "Device registration is incomplete" };
    }
    try {
      await webpush.sendNotification(
        { endpoint: d.endpoint, keys: { p256dh: d.p256dh, auth: d.auth } },
        payload,
        // A hung push service must not hold up the batch.
        { TTL: 60 * 60 * 12, urgency: "high", timeout: PUSH_TIMEOUT_MS },
      );
      return { ok: true };
    } catch (e) {
      const status = (e as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) return { ok: false, gone: true, error: `Subscription gone (${status})` };
      // 429 and 5xx are the push service's problem today; 4xx is ours forever.
      const permanent = status !== undefined && status >= 400 && status < 500 && status !== 429;
      return { ok: false, permanent, error: `Push failed (${status ?? "network"})` };
    }
  },
  email(d, url) {
    if (!d.email) return Promise.resolve({ ok: false, permanent: true, error: "Member has no email address" });
    return sendIdempotent(
      {
        to: d.email,
        subject: "A new pick is waiting in Tito Circle",
        text: `Tito has posted a new pick.\n\nOpen Tito Circle to read it: ${url}\n\nYou are receiving this because you are a member of Tito Circle.`,
        html: layout("A new pick is waiting", ["Tito has posted a new pick for members."], { label: "Open Tito Circle", url }),
      },
      `pick-alert-${d.id}`,
    );
  },
};

/** Queues a newly published pick's alerts. Idempotent. Returns rows added. */
export async function enqueuePickAlerts(pickId: string): Promise<number> {
  const { data, error } = await createServiceClient().rpc("enqueue_pick_notifications", { p_pick_id: pickId });
  if (error) throw new Error(`Could not queue alerts for pick ${pickId}: ${error.message}`);
  return data as number;
}

/**
 * Queues any live pick whose alerts were never queued because the publish
 * request died before enqueueing. Idempotent. Only picks from the last day:
 * an old pick is news no longer, and must never be announced as new.
 */
export async function enqueueUnqueuedPicks(): Promise<number> {
  const now = Date.now();
  const { data, error } = await createServiceClient()
    .from("picks")
    .select("id")
    .is("deleted_at", null)
    .is("notified_at", null)
    .lte("published_at", new Date(now).toISOString())
    .gte("published_at", new Date(now - 86_400_000).toISOString());
  if (error) throw new Error(`Could not list unqueued picks: ${error.message}`);
  let added = 0;
  for (const p of data ?? []) added += await enqueuePickAlerts(p.id);
  return added;
}

export type DrainResult ={ claimed: number; sent: number; retrying: number; failed: number; gone: number };

/**
 * Sends due alerts until the queue is empty or `budgetMs` runs out. Safe to
 * run anywhere, any number of times at once: claims use SKIP LOCKED, so
 * concurrent drains never take the same row.
 */
export async function drainAlerts(opts: { budgetMs?: number; senders?: Partial<Senders> } = {}): Promise<DrainResult> {
  const budgetMs = opts.budgetMs ?? 25_000;
  // Tests may replace one channel and keep the real other.
  const senders: Senders = { ...defaultSenders, ...opts.senders };
  const db = createServiceClient();
  const site = env.siteUrl();
  const deadline = Date.now() + budgetMs;
  const totals: DrainResult = { claimed: 0, sent: 0, retrying: 0, failed: 0, gone: 0 };

  while (Date.now() < deadline) {
    const { data, error } = await db.rpc("claim_notification_batch", {
      p_limit: BATCH_SIZE,
      p_lock_seconds: LOCK_SECONDS,
      p_max_attempts: MAX_ATTEMPTS,
    });
    if (error) throw new Error(`Could not claim alerts: ${error.message}`);
    const batch = (data ?? []) as Delivery[];
    if (batch.length === 0) break;
    totals.claimed += batch.length;

    for (let i = 0; i < batch.length; i += CONCURRENCY) {
      // Out of time: stop between chunks. Rows already claimed but not sent
      // stay locked and are reclaimed by the next run once the lock lapses.
      if (Date.now() >= deadline) break;
      await Promise.all(batch.slice(i, i + CONCURRENCY).map((d) => deliver(d, senders, site, totals)));
    }
  }

  if (totals.claimed > 0) {
    console.log(
      `[alerts] claimed ${totals.claimed}: ${totals.sent} sent, ${totals.retrying} retrying, ${totals.failed} failed, ${totals.gone} devices gone`,
    );
  }
  return totals;
}

async function deliver(d: Delivery, senders: Senders, site: string, totals: DrainResult): Promise<void> {
  const db = createServiceClient();
  let outcome: PushOutcome;
  try {
    outcome =
      d.channel === "push"
        ? await senders.push(d, JSON.stringify({ title: "New pick from Tito", body: "A new pick is waiting for you in the Circle.", url: `/picks/${d.pick_id}` }))
        : await senders.email(d, `${site}/picks/${d.pick_id}`);
  } catch (e) {
    // A sender that throws is treated as a transient failure, never as sent.
    outcome = { ok: false, permanent: false, error: e instanceof Error ? e.message : String(e) };
  }

  if (!outcome.ok && "gone" in outcome) {
    // The browser dropped this subscription. Deleting it removes the
    // delivery row with it (on delete cascade): nothing left to retry.
    const { error } = await db.from("push_subscriptions").delete().eq("id", d.push_subscription_id!);
    if (error) console.error(`[alerts] could not remove dead subscription: ${error.message}`);
    totals.gone++;
    return;
  }

  const { data: recorded, error } = await db.rpc("complete_notification", {
    p_id: d.id,
    p_attempts: d.attempts,
    p_ok: outcome.ok,
    p_error: outcome.ok ? null : outcome.error,
    p_permanent: outcome.ok ? false : outcome.permanent,
    p_max_attempts: MAX_ATTEMPTS,
    p_retry_after_seconds: outcome.ok || !("retryAfterSeconds" in outcome) ? null : (outcome.retryAfterSeconds ?? null),
  });
  if (error) {
    // The row stays locked and is reclaimed when the lock lapses: for email
    // the idempotency key stops a second send; push may repeat once.
    console.error(`[alerts] could not record outcome for ${d.id}: ${error.message}`);
    return;
  }
  if (recorded === false) {
    // This worker was too slow: its lock lapsed and another worker owns the
    // row now. Its result is that worker's to record.
    console.warn(`[alerts] ${d.id}: outcome not recorded, the row was reclaimed by another worker`);
    return;
  }

  if (outcome.ok) totals.sent++;
  else if (outcome.permanent || d.attempts >= MAX_ATTEMPTS) totals.failed++;
  else totals.retrying++;
}

/** Removes push registrations of members who have had no access for 30 days. */
export async function purgeLapsedDevices(): Promise<number> {
  const { data, error } = await createServiceClient().rpc("purge_lapsed_push_subscriptions");
  if (error) throw new Error(`Could not purge lapsed devices: ${error.message}`);
  return data as number;
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
