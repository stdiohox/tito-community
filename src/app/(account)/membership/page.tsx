import type { Metadata } from "next";
import { manageAutoRenew } from "./actions";
import { requireSignedIn } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { addDays, daysUntil, longDate, naira } from "@/lib/format";
import { CHECKOUT_ERRORS, ProductOptions, type Product } from "@/components/product-options";
import { SubmitButton } from "@/components/submit-button";
import { Card, Notice, PageTitle } from "@/components/ui";
import { PushToggle } from "@/components/push-toggle";
import { env } from "@/lib/env";

export const metadata: Metadata = { title: "My membership" };

export default async function MembershipPage({ searchParams }: PageProps<"/membership">) {
  const state = await requireSignedIn();
  const { error } = await searchParams;
  const supabase = await createClient();

  const [{ data: products }, { data: subs }, { data: payments }] = await Promise.all([
    supabase
      .from("products")
      .select("id, name, description, price_kobo, access_months, paystack_plan_code")
      .eq("active", true)
      .order("price_kobo"),
    supabase
      .from("subscriptions")
      .select("subscription_code, status, next_payment_date")
      .eq("user_id", state.viewer.userId)
      .order("updated_at", { ascending: false })
      .limit(1),
    supabase
      .from("payments")
      .select("reference, amount_kobo, paid_at, term_ends_at, kind")
      .eq("user_id", state.viewer.userId)
      .order("paid_at", { ascending: false })
      .limit(10),
  ]);

  const sub = subs?.[0];
  const autoRenewOn = sub?.status === "active";
  const ends = state.accessEndsAt;
  const days = ends ? daysUntil(ends) : null;
  const graceUntil = ends ? addDays(ends, state.graceDays) : null;
  const errorText = typeof error === "string" ? CHECKOUT_ERRORS[error] : undefined;

  return (
    <>
      <PageTitle eyebrow={state.viewer.email} title="My membership" />
      {errorText ? (
        <div className="mb-6">
          <Notice tone="error">{errorText}</Notice>
        </div>
      ) : null}

      <Card className="overflow-hidden">
        <div className="bg-forest px-6 py-7 text-ivory">
          <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-gold">
            {state.status === "revoked" ? "Suspended" : state.hasAccess ? "Active" : ends ? "Ended" : "No membership yet"}
          </p>
          {state.status === "revoked" ? (
            <p className="mt-3 font-display text-3xl">Your access is suspended.</p>
          ) : days !== null && days > 0 ? (
            <p className="mt-2 flex items-baseline gap-3">
              <span className="tabular font-display text-[4.5rem] leading-none text-ivory">{days}</span>
              <span className="text-ivory/75">day{days === 1 ? "" : "s"} left</span>
            </p>
          ) : (
            <p className="mt-3 font-display text-3xl">{ends ? "Your membership has ended." : "You have no active membership."}</p>
          )}
        </div>
        <dl className="grid gap-4 p-6 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-muted">{days !== null && days > 0 ? "Access ends" : "Access ended"}</dt>
            <dd className="mt-0.5 font-medium">{ends ? longDate(ends) : "—"}</dd>
          </div>
          <div>
            <dt className="text-muted">Auto-renew</dt>
            <dd className="mt-0.5 font-medium">
              {autoRenewOn
                ? `On${sub?.next_payment_date ? `, next charge ${longDate(sub.next_payment_date)}` : ""}`
                : sub?.status === "attention"
                  ? "Payment failed. Update your card."
                  : "Off"}
            </dd>
          </div>
          {ends && days !== null && days <= 0 && state.hasAccess && graceUntil ? (
            <div className="sm:col-span-2">
              <Notice tone="warning">You are in a {state.graceDays}-day grace period until {longDate(graceUntil)}. Renew to keep reading.</Notice>
            </div>
          ) : null}
          {state.status === "revoked" && state.statusReason ? (
            <div className="sm:col-span-2">
              <Notice tone="error">{state.statusReason}</Notice>
            </div>
          ) : null}
        </dl>
        {sub && ["active", "attention", "non-renewing"].includes(sub.status) ? (
          <form action={manageAutoRenew} className="border-t border-line px-6 py-4">
            <SubmitButton variant="ghost" pending="Opening Paystack…">
              Manage auto-renew or card
            </SubmitButton>
          </form>
        ) : null}
      </Card>

      {state.status !== "revoked" ? (
        <section className="mt-10 space-y-4" aria-labelledby="renew-heading">
          <h2 id="renew-heading" className="font-display text-3xl text-forest">
            {state.hasAccess ? "Renew or extend" : "Renew"}
          </h2>
          {products && products.length > 0 ? (
            <ProductOptions products={products as Product[]} accessEndsAt={ends} hasAutoRenew={autoRenewOn} from="membership" />
          ) : (
            <Notice>No membership options are on sale right now.</Notice>
          )}
        </section>
      ) : null}

      <section className="mt-10 space-y-3">
        <h2 className="font-display text-2xl text-forest">Alerts</h2>
        <PushToggle vapidPublicKey={env.vapidPublicKey() ?? null} />
      </section>

      {payments && payments.length > 0 ? (
        <section className="mt-10" aria-labelledby="history-heading">
          <h2 id="history-heading" className="mb-3 font-display text-2xl text-forest">
            Payment history
          </h2>
          <ul className="divide-y divide-line rounded-2xl border border-line bg-paper">
            {payments.map((p) => (
              <li key={p.reference} className="flex items-center justify-between gap-4 px-5 py-3 text-sm">
                <div className="min-w-0">
                  <p className="font-medium">{longDate(p.paid_at)}</p>
                  <p className="truncate text-xs text-muted">
                    {p.kind === "renewal" ? "Auto-renewal" : p.kind === "subscription" ? "Auto-renew started" : "One-off"} · access to{" "}
                    {longDate(p.term_ends_at)}
                  </p>
                </div>
                <p className="tabular shrink-0 font-mono">{naira(p.amount_kobo)}</p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}
