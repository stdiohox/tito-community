import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { PickCard, type Pick } from "@/components/pick-card";
import { EmptyState, PageTitle } from "@/components/ui";
import { PushToggle } from "@/components/push-toggle";
import { env } from "@/lib/env";

export const metadata: Metadata = { title: "Picks" };

export default async function PicksPage() {
  const supabase = await createClient();

  // RLS returns rows only while the reader has access. No filter here is
  // what keeps members out; the database is.
  const [{ data: picks, error }, { data: updates }] = await Promise.all([
    supabase
      .from("picks")
      .select("id, ticker, market, action, entry_price, target_price, stop_price, rationale, author_holds, chart_path, published_at")
      .is("deleted_at", null)
      .order("published_at", { ascending: false })
      .limit(50),
    supabase.from("pick_updates").select("pick_id").is("deleted_at", null),
  ]);
  if (error) throw new Error(`Could not load picks: ${error.message}`);

  const counts = new Map<string, number>();
  for (const u of updates ?? []) counts.set(u.pick_id, (counts.get(u.pick_id) ?? 0) + 1);

  return (
    <>
      <PageTitle eyebrow="Members only" title="Picks">
        Tito&apos;s calls, newest first. Open a pick for the full rationale and every update since.
      </PageTitle>
      <div className="mb-6">
        <PushToggle vapidPublicKey={env.vapidPublicKey() ?? null} />
      </div>
      {picks && picks.length > 0 ? (
        <div className="space-y-4">
          {(picks as Pick[]).map((p, i) => (
            <PickCard key={p.id} pick={p} index={i} updates={counts.get(p.id) ?? 0} />
          ))}
        </div>
      ) : (
        <EmptyState title="No picks yet">When Tito posts a pick it appears here, and you get a notification.</EmptyState>
      )}
    </>
  );
}
