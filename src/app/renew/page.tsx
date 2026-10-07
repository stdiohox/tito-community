import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireSignedIn } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { longDate } from "@/lib/format";
import { CHECKOUT_ERRORS, ProductOptions, type Product } from "@/components/product-options";
import { Notice, Wordmark } from "@/components/ui";
import { signOut } from "@/app/sign-in/actions";

export const metadata: Metadata = { title: "Renew" };

/** Where an expired member lands. Nothing paid is visible from here. */
export default async function RenewPage({ searchParams }: PageProps<"/renew">) {
  const state = await requireSignedIn();
  if (state.hasAccess || state.isStaff) redirect("/picks");
  const { error } = await searchParams;
  const errorText = typeof error === "string" ? CHECKOUT_ERRORS[error] : undefined;

  const supabase = await createClient();
  const [{ data: products }, { data: subs }] = await Promise.all([
    supabase
      .from("products")
      .select("id, name, description, price_kobo, access_months, paystack_plan_code")
      .eq("active", true)
      .order("price_kobo"),
    supabase.from("subscriptions").select("status").eq("user_id", state.viewer.userId).eq("status", "active").limit(1),
  ]);

  return (
    <div className="min-h-dvh bg-ivory">
      <div className="on-dark bg-forest pb-24 pt-[max(2rem,env(safe-area-inset-top))] text-ivory">
        <div className="mx-auto flex max-w-xl items-center justify-between px-4 sm:px-6">
          <Wordmark />
          <form action={signOut}>
            <button className="min-h-11 rounded-full px-3 text-xs text-ivory/75 hover:text-ivory">Sign out</button>
          </form>
        </div>
        <div className="rise mx-auto mt-12 max-w-xl px-4 sm:px-6">
          <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-gold">
            {state.status === "revoked" ? "Membership suspended" : state.accessEndsAt ? "Membership ended" : "Membership required"}
          </p>
          <h1 className="mt-3 font-display text-[2.8rem] leading-[1.05]">
            {state.status === "revoked" ? "Your access is on hold." : "Rejoin the Circle."}
          </h1>
          <p className="mt-3 max-w-md text-[15px] leading-relaxed text-ivory/75">
            {state.status === "revoked"
              ? "Please contact the Tito Finance team to restore your access."
              : state.accessEndsAt
                ? `Your access ended on ${longDate(state.accessEndsAt)}. Renew to see every pick and update again, straight away.`
                : "Choose a membership to unlock Tito's picks, updates and notices."}
          </p>
        </div>
      </div>
      <main className="mx-auto -mt-14 max-w-xl px-4 pb-[max(3rem,env(safe-area-inset-bottom))] sm:px-6">
        {errorText ? (
          <div className="mb-4">
            <Notice tone="error">{errorText}</Notice>
          </div>
        ) : null}
        {state.status === "revoked" ? null : products && products.length > 0 ? (
          <ProductOptions
            products={products as Product[]}
            accessEndsAt={state.accessEndsAt}
            hasAutoRenew={Boolean(subs && subs.length > 0)}
            from="renew"
          />
        ) : (
          <Notice>No membership options are on sale right now. Please contact the Tito Finance team.</Notice>
        )}
      </main>
    </div>
  );
}
