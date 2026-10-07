"use server";

import { createHmac } from "node:crypto";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { POST as paystackWebhook } from "@/app/api/paystack/webhook/route";
import { currentVisitor, ownerQuery, resetVisitor } from "@/lib/demo/db";
import { sessionFor } from "@/lib/demo/fake-auth";
import { markTransactionPaid } from "@/lib/demo/fake-services";
import { isDemo } from "@/lib/demo/mode";
import { DEMO_USERS } from "@/lib/demo/seed";
import { env } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";

/*
 * Client preview mode only. Every action refuses to run outside it.
 */

function demoOnly() {
  if (!isDemo()) notFound();
}

const LANDING = {
  admin: "/admin",
  active: "/picks",
  expiring: "/picks",
  expired: "/picks",
} as const;

/** Signs in as a sample persona through the real session mechanism. */
export async function switchPersona(formData: FormData) {
  demoOnly();
  const persona = z.enum(["admin", "active", "expiring", "expired", "signedout"]).parse(formData.get("persona"));
  const supabase = await createClient();

  if (persona === "signedout") {
    await supabase.auth.signOut();
    redirect("/sign-in");
  }

  const u = DEMO_USERS[persona];
  // Tito arrives with two-factor already passed, so the admin area opens
  // straight away. (Signing in as Tito through the form shows the two-factor
  // step, where any 6-digit code works.)
  const s = await sessionFor(await currentVisitor(), { id: u.id, email: u.email }, persona === "admin" ? "aal2" : "aal1");
  const { error } = await supabase.auth.setSession({ access_token: s.access_token, refresh_token: s.refresh_token });
  if (error) throw new Error(`Could not switch persona: ${error.message}`);
  redirect(LANDING[persona]);
}

/** Back to the untouched sample data. */
export async function resetDemo() {
  demoOnly();
  await resetVisitor();
  redirect("/");
}

/** Delivers an event to the app's REAL Paystack webhook handler, correctly signed. */
async function deliverWebhook(event: Record<string, unknown>) {
  const body = JSON.stringify(event);
  const signature = createHmac("sha512", env.paystackSecretKey()!).update(body).digest("hex");
  const res = await paystackWebhook(
    new Request("https://demo.invalid/api/paystack/webhook", {
      method: "POST",
      body,
      headers: { "content-type": "application/json", "x-paystack-signature": signature },
    }),
  );
  if (!res.ok) throw new Error(`Simulated webhook ${String(event.event)} failed with ${res.status}`);
}

/**
 * The "Pay" button on the simulated Paystack checkout. Marks the transaction
 * paid, then runs exactly what a real payment triggers: charge.success (and,
 * for auto-renew, subscription.create) through the real webhook handler,
 * which re-verifies with "Paystack" and extends access.
 */
export async function payDemoCheckout(formData: FormData) {
  demoOnly();
  const reference = z.string().regex(/^tc_[0-9a-f]{32}$/).parse(formData.get("reference"));
  const v = await currentVisitor();
  const txn = await markTransactionPaid(v, reference);

  if (txn) {
    await deliverWebhook({ event: "charge.success", data: { reference } });
    if (txn.plan_code) {
      const months = { PLN_demo_1m: 1, PLN_demo_3m: 3 }[txn.plan_code as "PLN_demo_1m" | "PLN_demo_3m"] ?? 6;
      const next = new Date();
      next.setMonth(next.getMonth() + months);
      await deliverWebhook({
        event: "subscription.create",
        data: {
          subscription_code: `SUB_demo_${reference.slice(-10)}`,
          status: "active",
          next_payment_date: next.toISOString(),
          customer: { email: txn.email, customer_code: txn.customer_code },
          plan: { plan_code: txn.plan_code },
        },
      });
    }
  }

  // Back through Paystack's normal return path, which verifies the payment.
  const back = txn?.callback_url ? new URL(txn.callback_url).pathname : "/membership/confirm";
  redirect(`${back}?reference=${reference}&trxref=${reference}`);
}

/** "Turn off auto-renew" on the simulated Paystack subscription page. */
export async function disableDemoSubscription(formData: FormData) {
  demoOnly();
  const code = z.string().regex(/^SUB_[A-Za-z0-9_]+$/).parse(formData.get("code"));
  const [sub] = await ownerQuery<{ email: string; customer_code: string | null; plan_code: string | null }>(
    `select p.email, p.paystack_customer_code as customer_code, pr.paystack_plan_code as plan_code
       from public.subscriptions s
       join public.profiles p on p.user_id = s.user_id
       left join public.products pr on pr.id = s.product_id
      where s.subscription_code = $1`,
    [code],
  );
  if (sub) {
    await deliverWebhook({
      event: "subscription.disable",
      data: {
        subscription_code: code,
        status: "complete",
        customer: { email: sub.email, customer_code: sub.customer_code ?? undefined },
        plan: sub.plan_code ? { plan_code: sub.plan_code } : null,
      },
    });
  }
  redirect("/membership");
}
