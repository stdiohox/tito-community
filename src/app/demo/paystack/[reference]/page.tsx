import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { payDemoCheckout } from "@/app/demo/actions";
import { getViewer } from "@/lib/auth";
import { ownerQuery } from "@/lib/demo/db";
import { isDemo } from "@/lib/demo/mode";
import { naira } from "@/lib/format";
import { SubmitButton } from "@/components/submit-button";

export const metadata: Metadata = { title: "Simulated checkout" };

/**
 * Client preview mode only: a stand-in for Paystack's hosted checkout. "Pay"
 * runs the app's real payment path (verify, webhook, record_payment). No
 * card is charged and no money moves.
 */
export default async function DemoCheckout({ params }: PageProps<"/demo/paystack/[reference]">) {
  if (!isDemo()) notFound();
  const { reference } = await params;
  const viewer = await getViewer();
  const [txn] = await ownerQuery<{ reference: string; email: string; amount_kobo: string; plan_code: string | null; status: string }>(
    `select reference, email, amount_kobo, plan_code, status from public.demo_paystack_transactions where reference = $1`,
    [decodeURIComponent(reference)],
  );
  // Only the member who started this checkout sees it.
  if (!txn || !viewer || txn.email.toLowerCase() !== viewer.email.toLowerCase()) notFound();

  const autoRenew = Boolean(txn.plan_code);
  return (
    <main className="min-h-dvh bg-[#f4f6f8] px-4 py-10 text-[#0b1a33]">
      <div className="mx-auto max-w-sm overflow-hidden rounded-xl bg-white shadow-[0_20px_50px_-20px_rgb(11_26_51/0.35)]">
        <div className="flex items-center justify-between border-b border-[#e6ebf1] px-5 py-4">
          <p className="text-sm font-semibold">
            Paystack <span className="ml-1 rounded bg-[#fff4d6] px-1.5 py-0.5 text-[11px] font-medium text-[#7a5a00]">Simulated</span>
          </p>
          <p className="text-right text-xs text-[#5b6b82]">
            {txn.email}
            <br />
            <span className="tabular text-base font-semibold text-[#0b1a33]">{naira(Number(txn.amount_kobo))}</span>
          </p>
        </div>
        <div className="space-y-4 px-5 py-5">
          <p className="rounded-lg bg-[#eef7ff] px-3 py-2 text-xs leading-relaxed text-[#18406b]">
            Demo checkout. No card is charged and no money moves. {autoRenew ? "This starts card auto-renew." : "One-off payment."}
          </p>
          {txn.status === "success" ? (
            <p className="text-sm">This payment is already complete.</p>
          ) : (
            <form action={payDemoCheckout} className="space-y-3">
              <input type="hidden" name="reference" value={txn.reference} />
              <div>
                <label htmlFor="card" className="text-xs font-medium text-[#5b6b82]">
                  Card number
                </label>
                <input id="card" readOnly value="4084 0840 8408 4081" className="mt-1 block w-full rounded-md border border-[#c9d3df] px-3 py-2 font-mono text-sm" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label htmlFor="exp" className="text-xs font-medium text-[#5b6b82]">
                    Expiry
                  </label>
                  <input id="exp" readOnly value="12 / 30" className="mt-1 block w-full rounded-md border border-[#c9d3df] px-3 py-2 font-mono text-sm" />
                </div>
                <div>
                  <label htmlFor="cvv" className="text-xs font-medium text-[#5b6b82]">
                    CVV
                  </label>
                  <input id="cvv" readOnly value="408" className="mt-1 block w-full rounded-md border border-[#c9d3df] px-3 py-2 font-mono text-sm" />
                </div>
              </div>
              <SubmitButton pending="Processing…" className="!w-full !rounded-md !bg-[#0ba4db] !text-white hover:!bg-[#0993c4]">
                Pay {naira(Number(txn.amount_kobo))}
              </SubmitButton>
            </form>
          )}
          <Link href="/membership" className="block text-center text-xs text-[#5b6b82] underline underline-offset-4">
            Cancel and go back
          </Link>
        </div>
      </div>
    </main>
  );
}
