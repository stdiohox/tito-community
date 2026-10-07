import { after } from "next/server";
import { env } from "@/lib/env";
import { layout, sendEmail } from "@/lib/email";
import { processReference } from "@/lib/payments";
import { verifySignature } from "@/lib/paystack";
import { createServiceClient } from "@/lib/supabase/server";

type PaystackEvent = {
  event: string;
  data: {
    reference?: string;
    subscription_code?: string;
    status?: string;
    next_payment_date?: string | null;
    customer?: { email?: string; customer_code?: string };
    plan?: { plan_code?: string } | string;
    subscription?: { subscription_code?: string; status?: string; next_payment_date?: string | null };
  };
};

/**
 * Paystack webhook.
 *
 * 1. The signature is checked against the RAW body before anything is parsed.
 * 2. charge.success is never trusted as sent: processReference re-fetches the
 *    transaction from Paystack and matches it to our own checkout intent (or,
 *    for auto-renewals, to the plan and the member's customer code).
 * 3. Idempotency lives in the database: record_payment claims the reference
 *    in the same transaction that extends access, so a replay is a no-op.
 * 4. Any unexpected failure returns 500, so Paystack retries.
 */
export async function POST(request: Request) {
  const raw = await request.text();
  if (!verifySignature(raw, request.headers.get("x-paystack-signature"))) {
    return new Response("Invalid signature", { status: 401 });
  }

  let event: PaystackEvent;
  try {
    event = JSON.parse(raw) as PaystackEvent;
  } catch {
    return new Response("Bad JSON", { status: 400 });
  }

  try {
    switch (event.event) {
      case "charge.success": {
        const reference = event.data.reference;
        if (!reference) return new Response("Missing reference", { status: 400 });
        const result = await processReference(reference);
        if (result.state === "rejected") {
          // Not retryable: Paystack resending the same event cannot change
          // the answer. Logged loudly for a human to look at.
          console.error(`[webhook] ${reference} rejected: ${result.reason}`);
        } else {
          console.log(`[webhook] ${reference}: ${result.state}`);
        }
        return Response.json({ ok: true });
      }

      case "subscription.create":
      case "subscription.not_renew":
      case "subscription.disable":
      case "subscription.expiring_cards":
        await upsertSubscription(event);
        return Response.json({ ok: true });

      case "invoice.payment_failed":
        await paymentFailed(event);
        return Response.json({ ok: true });

      default:
        return Response.json({ ok: true, ignored: event.event });
    }
  } catch (e) {
    console.error(`[webhook] ${event.event} failed: ${e instanceof Error ? e.message : e}`);
    return new Response("Processing failed", { status: 500 });
  }
}

/** Finds the member a Paystack customer belongs to: customer code first, then exact email. */
async function memberFor(customer: { email?: string; customer_code?: string } | undefined) {
  const db = createServiceClient();
  if (customer?.customer_code) {
    const { data } = await db.from("profiles").select("user_id, email").eq("paystack_customer_code", customer.customer_code).maybeSingle();
    if (data) return data;
  }
  if (customer?.email) {
    const { data } = await db.from("profiles").select("user_id, email").eq("email", customer.email.toLowerCase()).maybeSingle();
    if (data) return data;
  }
  return null;
}

async function upsertSubscription(event: PaystackEvent) {
  const d = event.data;
  const code = d.subscription_code ?? d.subscription?.subscription_code;
  if (!code) throw new Error(`${event.event} without subscription_code`);

  const member = await memberFor(d.customer);
  if (!member) {
    console.error(`[webhook] ${event.event} ${code}: no member for customer`);
    return;
  }

  const db = createServiceClient();
  const planCode = typeof d.plan === "string" ? d.plan : d.plan?.plan_code;
  const { data: product } = planCode
    ? await db.from("products").select("id").eq("paystack_plan_code", planCode).maybeSingle()
    : { data: null };

  const KNOWN = ["active", "non-renewing", "attention", "completed", "cancelled"];
  const status =
    event.event === "subscription.disable"
      ? "cancelled"
      : event.event === "subscription.not_renew"
        ? "non-renewing"
        : KNOWN.includes(d.status ?? "")
          ? d.status!
          : event.event === "subscription.create"
            ? "active"
            : "attention";

  const { error } = await db.from("subscriptions").upsert(
    {
      subscription_code: code,
      user_id: member.user_id,
      product_id: product?.id ?? null,
      status,
      next_payment_date: d.next_payment_date ?? null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "subscription_code" },
  );
  if (error) throw new Error(`subscription upsert failed: ${error.message}`);
}

async function paymentFailed(event: PaystackEvent) {
  const code = event.data.subscription?.subscription_code ?? event.data.subscription_code;
  const member = await memberFor(event.data.customer);
  if (!member) return;

  if (code) {
    const db = createServiceClient();
    await db
      .from("subscriptions")
      .update({ status: "attention", updated_at: new Date().toISOString() })
      .eq("subscription_code", code);
  }

  const url = `${env.siteUrl()}/membership`;
  after(() =>
    sendEmail({
      to: member.email,
      subject: "Your Tito Circle renewal did not go through",
      text: `We could not charge your card for your Tito Circle renewal. Your access continues until your current end date.\n\nUpdate your card or pay once here: ${url}`,
      html: layout(
        "Your renewal did not go through",
        ["We could not charge your card for your Tito Circle renewal.", "Your access continues until your current end date. Update your card or pay once to keep it going."],
        { label: "Renew now", url },
      ),
    }),
  );
}
