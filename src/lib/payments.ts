import "server-only";
import { createServiceClient } from "@/lib/supabase/server";
import { planCodeOf, verifyTransaction } from "@/lib/paystack";

export type ProcessResult =
  | { state: "recorded" | "duplicate"; termEndsAt: string }
  | { state: "pending" }
  | { state: "rejected"; reason: string };

/**
 * The single path from a Paystack reference to access. The webhook and the
 * member's return page both call it, so whichever arrives first grants access
 * and the other is a no-op (record_payment claims the reference atomically).
 *
 * Nothing in the webhook payload is trusted. The transaction is re-fetched
 * from Paystack with the secret key, then checked against what OUR server
 * recorded when it started the checkout:
 *   - first payments must match a checkout_intents row (user, product, amount,
 *     plan). Metadata is ignored: Paystack's public key can attach any.
 *   - recurring subscription charges carry no intent; they are matched by the
 *     plan code to a product and by the Paystack customer code (recorded on
 *     the first verified payment) to a member, and the amount must equal the
 *     product price.
 */
export async function processReference(reference: string): Promise<ProcessResult> {
  const tx = await verifyTransaction(reference);

  if (tx.status !== "success") {
    return { state: "pending" };
  }
  if (tx.currency !== "NGN") {
    return { state: "rejected", reason: `Unexpected currency ${tx.currency}` };
  }

  const db = createServiceClient();
  const planCode = planCodeOf(tx);
  const paidAt = tx.paid_at ?? tx.paidAt ?? new Date().toISOString();

  const { data: intent, error: intentError } = await db
    .from("checkout_intents")
    .select("user_id, product_id, kind, amount_kobo, plan_code")
    .eq("reference", reference)
    .maybeSingle();
  if (intentError) throw new Error(`checkout_intents lookup failed: ${intentError.message}`);

  let userId: string;
  let productId: string;
  let kind: "one_off" | "subscription" | "renewal";

  if (intent) {
    if (tx.amount !== intent.amount_kobo) {
      return { state: "rejected", reason: `Amount ${tx.amount} does not match intent ${intent.amount_kobo}` };
    }
    if (intent.kind === "subscription" && planCode !== intent.plan_code) {
      return { state: "rejected", reason: `Plan ${planCode} does not match intent ${intent.plan_code}` };
    }
    userId = intent.user_id;
    productId = intent.product_id;
    kind = intent.kind;
  } else {
    if (!planCode) {
      return { state: "rejected", reason: "No checkout intent and no plan: not a payment this app started" };
    }
    const { data: product } = await db
      .from("products")
      .select("id, price_kobo")
      .eq("paystack_plan_code", planCode)
      .maybeSingle();
    if (!product) {
      return { state: "rejected", reason: `No product for plan ${planCode}` };
    }
    if (tx.amount !== product.price_kobo) {
      return { state: "rejected", reason: `Renewal amount ${tx.amount} does not match price ${product.price_kobo}` };
    }
    const { data: profile } = await db
      .from("profiles")
      .select("user_id")
      .eq("paystack_customer_code", tx.customer.customer_code)
      .maybeSingle();
    if (!profile) {
      return { state: "rejected", reason: `No member for customer ${tx.customer.customer_code}` };
    }
    userId = profile.user_id;
    productId = product.id;
    kind = "renewal";
  }

  const { data, error } = await db.rpc("record_payment", {
    p_reference: reference,
    p_user_id: userId,
    p_product_id: productId,
    p_kind: kind,
    p_amount_kobo: tx.amount,
    p_currency: tx.currency,
    p_paid_at: paidAt,
  });
  if (error) throw new Error(`record_payment failed: ${error.message}`);

  // Remember the Paystack customer so future auto-renewals find this member.
  // Only set when empty: a code, once bound, is never moved to another member.
  if (intent && tx.customer?.customer_code) {
    const { error: bindError } = await db
      .from("profiles")
      .update({ paystack_customer_code: tx.customer.customer_code })
      .eq("user_id", userId)
      .is("paystack_customer_code", null);
    if (bindError) {
      if (bindError.code === "23505") {
        // Already bound to a different member. Never move it: log for a human.
        console.error(`[payments] customer ${tx.customer.customer_code} is bound to another member; ${reference} left unbound`);
      } else {
        // Access is already granted (record_payment committed). Throwing makes
        // Paystack retry; the retry is a duplicate for access and re-runs this
        // bind, so a member's future auto-renewals are not silently orphaned.
        throw new Error(`Could not bind Paystack customer for ${reference}: ${bindError.message}`);
      }
    }
  }

  const result = data as { status: "recorded" | "duplicate"; term_ends_at: string };
  return { state: result.status, termEndsAt: result.term_ends_at };
}
