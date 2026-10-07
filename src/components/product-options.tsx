import { startCheckout } from "@/app/(account)/membership/actions";
import { SubmitButton } from "@/components/submit-button";
import { ACCESS_MONTH_LABEL, longDate, naira } from "@/lib/format";

export type Product = {
  id: string;
  name: string;
  description: string | null;
  price_kobo: number;
  access_months: number;
  paystack_plan_code: string | null;
};

/** When a purchase now would end: stacked on any time still held. */
function endIfBoughtNow(accessEndsAt: string | null, months: number): string {
  const now = new Date();
  const held = accessEndsAt ? new Date(accessEndsAt) : null;
  const start = held && held > now ? held : now;
  const end = new Date(start);
  end.setMonth(end.getMonth() + months);
  return end.toISOString();
}

export function ProductOptions({
  products,
  accessEndsAt,
  hasAutoRenew,
  from,
}: {
  products: Product[];
  accessEndsAt: string | null;
  hasAutoRenew: boolean;
  from: "membership" | "renew";
}) {
  const stillActive = accessEndsAt !== null && new Date(accessEndsAt) > new Date();
  return (
    <div className="space-y-4">
      {products.map((p, i) => (
        <div
          key={p.id}
          className="rise overflow-hidden rounded-2xl border border-line bg-paper"
          style={{ ["--i" as string]: i }}
        >
          <div className="flex items-start justify-between gap-4 border-b border-line bg-forest px-5 py-4 text-ivory">
            <div className="min-w-0">
              <p className="font-display text-2xl leading-tight">{p.name}</p>
              <p className="mt-0.5 text-sm text-ivory/70">{ACCESS_MONTH_LABEL[p.access_months]} of access</p>
            </div>
            <p className="tabular shrink-0 font-mono text-lg text-gold">{naira(p.price_kobo)}</p>
          </div>
          <div className="space-y-4 p-5">
            {p.description ? <p className="text-[15px] leading-relaxed text-muted">{p.description}</p> : null}
            <p className="text-sm text-ink">
              {stillActive ? "Added to the end of your current membership. " : ""}
              Access until <strong className="font-medium">{longDate(endIfBoughtNow(accessEndsAt, p.access_months))}</strong>.
            </p>
            <form action={startCheckout} className="grid gap-2 sm:grid-cols-2">
              <input type="hidden" name="productId" value={p.id} />
              <input type="hidden" name="from" value={from} />
              {p.paystack_plan_code && !hasAutoRenew ? (
                <SubmitButton name="kind" value="subscription" pending="Opening Paystack…" variant="gold">
                  Auto-renew by card
                </SubmitButton>
              ) : null}
              <SubmitButton
                name="kind"
                value="one_off"
                pending="Opening Paystack…"
                variant={p.paystack_plan_code && !hasAutoRenew ? "ghost" : "primary"}
                className={p.paystack_plan_code && !hasAutoRenew ? "min-h-12" : "sm:col-span-2"}
              >
                Pay once (card, transfer, USSD)
              </SubmitButton>
            </form>
          </div>
        </div>
      ))}
      <p className="text-xs leading-relaxed text-muted">
        Payments are processed by Paystack. Auto-renew charges your card each period until you turn it off; only cards
        can auto-renew. Renewing early never loses days: new time is added after your current end date.
      </p>
    </div>
  );
}

export const CHECKOUT_ERRORS: Record<string, string> = {
  invalid: "That request was not valid. Please try again.",
  revoked: "Your membership has been suspended. Please contact the Tito Finance team.",
  payments_off: "Payments are not switched on yet. Please contact the Tito Finance team.",
  product: "That option is no longer available.",
  no_plan: "Auto-renew is not available for that option. You can pay once instead.",
  already_subscribed: "Auto-renew is already on for your membership.",
  paystack: "We could not reach Paystack. Please try again in a moment.",
  no_subscription: "You do not have auto-renew switched on.",
};
