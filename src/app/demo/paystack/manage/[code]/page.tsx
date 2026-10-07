import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { disableDemoSubscription } from "@/app/demo/actions";
import { getViewer } from "@/lib/auth";
import { ownerQuery } from "@/lib/demo/db";
import { isDemo } from "@/lib/demo/mode";
import { longDate } from "@/lib/format";
import { SubmitButton } from "@/components/submit-button";

export const metadata: Metadata = { title: "Manage auto-renew (simulated)" };

/** Client preview mode only: a stand-in for Paystack's "manage subscription" page. */
export default async function DemoManageSubscription({ params }: PageProps<"/demo/paystack/manage/[code]">) {
  if (!isDemo()) notFound();
  const { code } = await params;
  const viewer = await getViewer();
  const [sub] = await ownerQuery<{ subscription_code: string; status: string; next_payment_date: string | null; user_id: string; name: string | null }>(
    `select s.subscription_code, s.status, s.next_payment_date, s.user_id, p.name
       from public.subscriptions s left join public.products p on p.id = s.product_id
      where s.subscription_code = $1`,
    [decodeURIComponent(code)],
  );
  if (!sub || !viewer || sub.user_id !== viewer.userId) notFound();

  return (
    <main className="min-h-dvh bg-[#f4f6f8] px-4 py-10 text-[#0b1a33]">
      <div className="mx-auto max-w-sm space-y-4 rounded-xl bg-white p-5 shadow-[0_20px_50px_-20px_rgb(11_26_51/0.35)]">
        <p className="text-sm font-semibold">
          Paystack <span className="ml-1 rounded bg-[#fff4d6] px-1.5 py-0.5 text-[11px] font-medium text-[#7a5a00]">Simulated</span>
        </p>
        <h1 className="text-lg font-semibold">Your subscription</h1>
        <dl className="space-y-1 text-sm">
          <div className="flex justify-between gap-4">
            <dt className="text-[#5b6b82]">Plan</dt>
            <dd>{sub.name ?? "Tito Circle"}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-[#5b6b82]">Status</dt>
            <dd className="capitalize">{sub.status}</dd>
          </div>
          {sub.next_payment_date ? (
            <div className="flex justify-between gap-4">
              <dt className="text-[#5b6b82]">Next charge</dt>
              <dd>{longDate(sub.next_payment_date)}</dd>
            </div>
          ) : null}
        </dl>
        {sub.status === "active" ? (
          <form action={disableDemoSubscription}>
            <input type="hidden" name="code" value={sub.subscription_code} />
            <SubmitButton pending="Turning off…" className="!w-full !rounded-md !bg-[#0b1a33] !text-white">
              Turn off auto-renew
            </SubmitButton>
          </form>
        ) : null}
        <Link href="/membership" className="block text-center text-xs text-[#5b6b82] underline underline-offset-4">
          Back to Tito Circle
        </Link>
      </div>
    </main>
  );
}
