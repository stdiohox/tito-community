import type { Metadata } from "next";
import { requireStaffAal2 } from "@/lib/auth";
import Link from "next/link";
import { PickComposer } from "../forms";
import { createClient } from "@/lib/supabase/server";
import { ActionBadge } from "@/components/pick-card";
import { Card, Notice, PageTitle } from "@/components/ui";
import { shortDateTime } from "@/lib/format";

export const metadata: Metadata = { title: "Picks · Admin" };

export default async function AdminPicks({ searchParams }: PageProps<"/admin/picks">) {
  // Layouts and pages render in parallel, so each page guards itself too.
  await requireStaffAal2();
  const { removed } = await searchParams;
  const supabase = await createClient();
  const { data: picks } = await supabase
    .from("picks")
    .select("id, ticker, market, action, published_at, deleted_at")
    .order("published_at", { ascending: false })
    .limit(100);

  return (
    <div className="grid gap-10 lg:grid-cols-[1fr_22rem]">
      <section>
        <PageTitle eyebrow="New" title="Post a pick" />
        <Card className="p-5 sm:p-6">
          <PickComposer />
        </Card>
      </section>
      <section aria-labelledby="all-picks">
        <h2 id="all-picks" className="mb-3 font-display text-2xl text-forest">
          All picks
        </h2>
        {removed ? (
          <div className="mb-3">
            <Notice tone="success">Pick removed from the member feed.</Notice>
          </div>
        ) : null}
        <ul className="divide-y divide-line rounded-2xl border border-line bg-paper">
          {(picks ?? []).map((p) => (
            <li key={p.id}>
              <Link href={`/admin/picks/${p.id}`} className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-ivory-deep">
                <span className="min-w-0">
                  <span className={`block font-mono text-sm ${p.deleted_at ? "text-muted line-through" : ""}`}>{p.ticker}</span>
                  <span className="text-xs text-muted">
                    {p.market} · {shortDateTime(p.published_at)}
                  </span>
                </span>
                <ActionBadge action={p.action} />
              </Link>
            </li>
          ))}
          {(picks ?? []).length === 0 ? <li className="px-4 py-6 text-center text-sm text-muted">No picks yet.</li> : null}
        </ul>
      </section>
    </div>
  );
}
