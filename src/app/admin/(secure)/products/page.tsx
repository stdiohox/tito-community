import type { Metadata } from "next";
import { requireStaffAal2 } from "@/lib/auth";
import { ProductForm } from "../forms";
import { retryPlan, setProductActive } from "../../actions";
import { createClient } from "@/lib/supabase/server";
import { SubmitButton } from "@/components/submit-button";
import { Card, Notice, PageTitle } from "@/components/ui";
import { ACCESS_MONTH_LABEL, naira } from "@/lib/format";

export const metadata: Metadata = { title: "Products · Admin" };

const PLAN_RESULT: Record<string, { tone: "success" | "warning" | "error"; text: string }> = {
  attached: { tone: "success", text: "Auto-renew is now available for that product." },
  reused: { tone: "success", text: "Auto-renew is now available (an existing Paystack plan was reused, not duplicated)." },
  existing: { tone: "success", text: "That product already had auto-renew; nothing was created." },
  busy: { tone: "warning", text: "Auto-renew is already being set up for that product. Refresh in a moment." },
  unconfigured: { tone: "warning", text: "Paystack is not configured, so products sell as one-off only." },
  failed: { tone: "error", text: "Paystack plan set-up failed. Nothing was duplicated; try again shortly." },
};

export default async function AdminProducts({ searchParams }: PageProps<"/admin/products">) {
  // Layouts and pages render in parallel, so each page guards itself too.
  await requireStaffAal2();
  const { plan } = await searchParams;
  const planResult = typeof plan === "string" ? PLAN_RESULT[plan] : undefined;
  const supabase = await createClient();
  const { data } = await supabase
    .from("products")
    .select("id, name, description, price_kobo, access_months, paystack_plan_code, active")
    .order("created_at", { ascending: false });

  return (
    <>
      <PageTitle eyebrow="Products" title="What members can buy">
        Each product grants access for its length. Prices can&apos;t be edited once created, because live auto-renewals are billed on
        them; retire a product and create a new one instead.
      </PageTitle>
      {planResult ? (
        <div className="mb-6">
          <Notice tone={planResult.tone}>{planResult.text}</Notice>
        </div>
      ) : null}
      <Card className="mb-8 p-5 sm:p-6">
        <ProductForm />
      </Card>
      <ul className="space-y-3">
        {(data ?? []).map((p) => (
          <li key={p.id} className={`rounded-2xl border border-line bg-paper p-4 ${p.active ? "" : "opacity-60"}`}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="font-display text-xl">{p.name}</p>
                <p className="text-sm text-muted">
                  {ACCESS_MONTH_LABEL[p.access_months]} · {p.active ? "On sale" : "Retired"} ·{" "}
                  {p.paystack_plan_code ? <span className="font-mono text-xs">{p.paystack_plan_code}</span> : "No auto-renew plan"}
                </p>
              </div>
              <p className="tabular font-mono text-lg text-forest">{naira(p.price_kobo)}</p>
            </div>
            <div className="mt-3 flex flex-wrap gap-2 border-t border-line pt-3">
              <form action={setProductActive}>
                <input type="hidden" name="id" value={p.id} />
                <input type="hidden" name="active" value={p.active ? "false" : "true"} />
                <SubmitButton variant={p.active ? "danger" : "ghost"}>{p.active ? "Retire" : "Put back on sale"}</SubmitButton>
              </form>
              {!p.paystack_plan_code ? (
                <form action={retryPlan}>
                  <input type="hidden" name="id" value={p.id} />
                  <SubmitButton variant="ghost" pending="Creating plan…">
                    Create auto-renew plan
                  </SubmitButton>
                </form>
              ) : null}
            </div>
          </li>
        ))}
        {(data ?? []).length === 0 ? <li className="text-sm text-muted">No products yet.</li> : null}
      </ul>
    </>
  );
}
