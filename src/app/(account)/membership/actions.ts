"use server";

import { randomUUID } from "node:crypto";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireSignedIn } from "@/lib/auth";
import { env } from "@/lib/env";
import { initializeTransaction, paystackConfigured, subscriptionManageLink } from "@/lib/paystack";
import { createClient, createServiceClient } from "@/lib/supabase/server";

const checkoutSchema = z.object({
  productId: z.uuid(),
  kind: z.enum(["one_off", "subscription"]),
  from: z.enum(["membership", "renew"]).default("membership"),
});

/**
 * Starts a Paystack checkout. The checkout_intents row written here is what
 * the webhook later trusts: who is paying, for which product, how much, and
 * on which plan. Nothing the browser sends after this point can change it.
 */
export async function startCheckout(formData: FormData) {
  const state = await requireSignedIn();
  const parsed = checkoutSchema.safeParse({
    productId: formData.get("productId"),
    kind: formData.get("kind"),
    from: formData.get("from") ?? undefined,
  });
  const back = `/${parsed.success ? parsed.data.from : "membership"}`;
  if (!parsed.success) redirect(`${back}?error=invalid`);
  const { productId, kind } = parsed.data;

  if (state.status === "revoked") redirect(`${back}?error=revoked`);
  if (!paystackConfigured()) redirect(`${back}?error=payments_off`);

  const supabase = await createClient();
  const { data: product } = await supabase
    .from("products")
    .select("id, price_kobo, paystack_plan_code")
    .eq("id", productId)
    .eq("active", true)
    .maybeSingle();
  if (!product) redirect(`${back}?error=product`);

  if (kind === "subscription") {
    if (!product.paystack_plan_code) redirect(`${back}?error=no_plan`);
    const { data: live } = await supabase
      .from("subscriptions")
      .select("subscription_code")
      .eq("user_id", state.viewer.userId)
      .eq("status", "active")
      .limit(1);
    if (live && live.length > 0) redirect(`${back}?error=already_subscribed`);
  }

  const reference = `tc_${randomUUID().replace(/-/g, "")}`;
  const db = createServiceClient();
  const { error: intentError } = await db.from("checkout_intents").insert({
    reference,
    user_id: state.viewer.userId,
    product_id: product.id,
    kind,
    amount_kobo: product.price_kobo,
    plan_code: kind === "subscription" ? product.paystack_plan_code : null,
  });
  if (intentError) throw new Error(`Could not start checkout: ${intentError.message}`);

  let authorizationUrl: string;
  try {
    const tx = await initializeTransaction({
      email: state.viewer.email,
      amountKobo: product.price_kobo,
      reference,
      callbackUrl: `${env.siteUrl()}/membership/confirm`,
      planCode: kind === "subscription" ? product.paystack_plan_code! : undefined,
      metadata: { user_id: state.viewer.userId, product_id: product.id, kind },
    });
    authorizationUrl = tx.authorization_url;
  } catch (e) {
    console.error(`[checkout] ${e instanceof Error ? e.message : e}`);
    redirect(`${back}?error=paystack`);
  }

  redirect(authorizationUrl);
}

/** Paystack's hosted page for cancelling auto-renew or changing the card. */
export async function manageAutoRenew() {
  const state = await requireSignedIn();
  const supabase = await createClient();
  const { data: sub } = await supabase
    .from("subscriptions")
    .select("subscription_code")
    .eq("user_id", state.viewer.userId)
    .in("status", ["active", "attention", "non-renewing"])
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!sub) redirect("/membership?error=no_subscription");

  let link: string;
  try {
    link = (await subscriptionManageLink(sub.subscription_code)).link;
  } catch (e) {
    console.error(`[manage] ${e instanceof Error ? e.message : e}`);
    redirect("/membership?error=paystack");
  }
  redirect(link);
}
