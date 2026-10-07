import "server-only";
import { createPlan, findTaggedPlan, paystackConfigured } from "@/lib/paystack";
import { createServiceClient } from "@/lib/supabase/server";

export type PlanOutcome =
  | { status: "existing" | "attached" | "reused"; planCode: string }
  | { status: "busy" | "unconfigured" | "failed"; message: string };

/**
 * Gives a product its Paystack auto-renew plan, exactly once, however many
 * times it is called and whatever crashes in between. Never throws: the
 * product already exists when this runs, so a throw would invite the admin
 * to submit it again.
 *
 * Two guards, for the two ways a duplicate could happen:
 *
 * 1. Concurrent calls (a double click, two admins): claim_plan_creation lets
 *    one caller through with a claim token; the others get "busy". A claim
 *    lasts ten minutes, and every Paystack call times out after 20 seconds,
 *    so a live request never outlasts its claim.
 * 2. A crash after Paystack created the plan but before we saved its code:
 *    every plan's name ends with the product's tag, so the next attempt
 *    finds that plan on Paystack and attaches it instead of creating another.
 */
export async function ensurePaystackPlan(productId: string): Promise<PlanOutcome> {
  if (!paystackConfigured()) {
    return { status: "unconfigured", message: "Paystack is not configured, so it sells as one-off only for now." };
  }
  const db = createServiceClient();
  const failed = (why: string): PlanOutcome => {
    console.error(`[plans] ${productId}: ${why}`);
    return { status: "failed", message: "Paystack plan set-up failed, so it sells as one-off only for now. Retry from the list." };
  };

  const { data: product, error } = await db
    .from("products")
    .select("name, price_kobo, access_months, paystack_plan_code")
    .eq("id", productId)
    .maybeSingle();
  if (error || !product) return failed(`could not read product: ${error?.message ?? "not found"}`);
  if (product.paystack_plan_code) return { status: "existing", planCode: product.paystack_plan_code };

  const { data: claim, error: claimError } = await db.rpc("claim_plan_creation", { p_product_id: productId });
  if (claimError) return failed(`could not claim: ${claimError.message}`);
  if (!claim) {
    return { status: "busy", message: "Auto-renew is already being set up for this product. Refresh in a moment." };
  }

  try {
    const spec = { productId, amountKobo: product.price_kobo, accessMonths: product.access_months };
    const found = await findTaggedPlan(spec);
    const created = found ?? (await createPlan({ ...spec, name: product.name })).plan_code;

    const { data: winner, error: saveError } = await db.rpc("finish_plan_creation", {
      p_product_id: productId,
      p_plan_code: created,
      p_claim: claim,
    });
    if (saveError || !winner) throw new Error(`plan ${created} created but not saved: ${saveError?.message ?? "no row"}`);
    if (winner !== created) {
      // Another request saved its plan first. Ours is tagged and unused;
      // the next lookup for this product would find either. Nothing to undo.
      console.warn(`[plans] ${productId}: kept ${winner}; ${created} was created concurrently and is unused`);
    }
    return { status: found ? "reused" : "attached", planCode: winner as string };
  } catch (e) {
    // Let the next attempt in straight away rather than after the claim
    // expires. If the plan was created, its tag lets that attempt reuse it.
    const { error: releaseError } = await db.rpc("release_plan_claim", { p_product_id: productId, p_claim: claim });
    if (releaseError) console.error(`[plans] could not release claim for ${productId}: ${releaseError.message}`);
    return failed(e instanceof Error ? e.message : String(e));
  }
}

export function describePlanOutcome(o: PlanOutcome): string {
  switch (o.status) {
    case "attached":
      return "Auto-renew is available.";
    case "reused":
      return "Auto-renew is available (an existing Paystack plan was reused).";
    case "existing":
      return "Auto-renew was already set up.";
    default:
      return o.message;
  }
}
