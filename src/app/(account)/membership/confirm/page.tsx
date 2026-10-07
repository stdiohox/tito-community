import type { Metadata } from "next";
import Link from "next/link";
import { requireSignedIn } from "@/lib/auth";
import { processReference } from "@/lib/payments";
import { createServiceClient } from "@/lib/supabase/server";
import { longDate } from "@/lib/format";
import { buttonClass, Card, Notice } from "@/components/ui";

export const metadata: Metadata = { title: "Confirming payment" };

/**
 * Paystack sends the member back here with ?reference=. The page re-verifies
 * the transaction with Paystack (the same function the webhook uses), so
 * access opens even if the webhook is slow, and nothing in the URL is
 * trusted beyond being a reference to look up.
 */
export default async function ConfirmPage({ searchParams }: PageProps<"/membership/confirm">) {
  const state = await requireSignedIn();
  const params = await searchParams;
  const reference = typeof params.reference === "string" ? params.reference : typeof params.trxref === "string" ? params.trxref : null;

  let outcome: { tone: "success" | "warning" | "error"; title: string; body: string };

  if (!reference || !/^tc_[0-9a-f]{32}$/.test(reference)) {
    outcome = { tone: "error", title: "No payment to confirm", body: "This link does not point to a payment." };
  } else {
    // Only the member who started this checkout may confirm it here.
    const { data: intent } = await createServiceClient()
      .from("checkout_intents")
      .select("user_id")
      .eq("reference", reference)
      .maybeSingle();

    if (!intent || intent.user_id !== state.viewer.userId) {
      outcome = { tone: "error", title: "No payment to confirm", body: "This payment was not started from your account." };
    } else {
      try {
        const result = await processReference(reference);
        if (result.state === "rejected") {
          console.error(`[confirm] ${reference} rejected: ${result.reason}`);
          outcome = {
            tone: "error",
            title: "We could not match this payment",
            body: "Nothing has been lost. Contact the Tito Finance team with your payment reference and we will sort it out.",
          };
        } else if (result.state === "pending") {
          outcome = {
            tone: "warning",
            title: "Payment not completed yet",
            body: "Paystack has not confirmed this payment. If you completed it, refresh this page in a minute; your access updates automatically once it clears.",
          };
        } else {
          outcome = {
            tone: "success",
            title: "Payment received. Welcome back.",
            body: `Your access now runs until ${longDate(result.termEndsAt)}.`,
          };
        }
      } catch (e) {
        console.error(`[confirm] ${reference} failed: ${e instanceof Error ? e.message : e}`);
        outcome = {
          tone: "warning",
          title: "Still confirming",
          body: "We could not reach Paystack just now. Your access updates automatically once the payment is confirmed. Refresh in a minute.",
        };
      }
    }
  }

  return (
    <Card className="rise mx-auto max-w-lg p-6 sm:p-8">
      <h1 className="font-display text-3xl text-forest">{outcome.title}</h1>
      <div className="mt-4">
        <Notice tone={outcome.tone}>{outcome.body}</Notice>
      </div>
      {reference ? <p className="mt-4 break-all font-mono text-xs text-muted">Reference: {reference}</p> : null}
      <div className="mt-6 flex flex-wrap gap-3">
        <Link href="/picks" className={buttonClass.primary}>
          Go to picks
        </Link>
        <Link href="/membership" className={buttonClass.ghost}>
          My membership
        </Link>
      </div>
    </Card>
  );
}
