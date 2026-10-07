import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ActionBadge, PickFooter, PriceLadder, type Pick } from "@/components/pick-card";
import { Card } from "@/components/ui";
import { longDate, shortDateTime } from "@/lib/format";

export const metadata: Metadata = { title: "Pick" };

const UPDATE_LABEL: Record<string, string> = {
  note: "Note",
  target_hit: "Target hit",
  stop_hit: "Stop hit",
  closed: "Closed",
  revised: "Revised",
};

export default async function PickPage({ params }: PageProps<"/picks/[id]">) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();

  const supabase = await createClient();
  const { data: pick, error } = await supabase
    .from("picks")
    .select("id, ticker, market, action, entry_price, target_price, stop_price, rationale, author_holds, chart_path, published_at")
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle<Pick>();
  // A failed read is an error, not "no such pick".
  if (error) throw new Error(`Could not load pick: ${error.message}`);
  if (!pick) notFound();

  const { data: updates, error: updatesError } = await supabase
    .from("pick_updates")
    .select("id, kind, body, published_at")
    .eq("pick_id", id)
    .is("deleted_at", null)
    .order("published_at", { ascending: true });
  if (updatesError) throw new Error(`Could not load updates: ${updatesError.message}`);

  // A short-lived signed URL, created with the member's own session, so
  // storage RLS applies. Plain <img>, not next/image: the optimiser would
  // cache a private chart under a public URL.
  let chartUrl: string | null = null;
  if (pick.chart_path) {
    const { data } = await supabase.storage.from("charts").createSignedUrl(pick.chart_path, 300);
    chartUrl = data?.signedUrl ?? null;
  }

  return (
    <article className="rise space-y-6">
      <Link href="/picks" className="inline-flex items-center gap-1 text-sm text-muted hover:text-ink">
        ← All picks
      </Link>

      <header className="space-y-3">
        <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-muted">
          {pick.market} · {longDate(pick.published_at)}
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="font-display text-[3.2rem] leading-none text-ink">{pick.ticker}</h1>
          <ActionBadge action={pick.action} />
        </div>
      </header>

      <PriceLadder pick={pick} />

      {chartUrl ? (
        <figure className="overflow-hidden rounded-2xl border border-line bg-paper">
          {/* eslint-disable-next-line @next/next/no-img-element -- private signed URL, must not pass through the image optimiser cache */}
          <img src={chartUrl} alt={`Chart for ${pick.ticker}`} className="h-auto w-full" />
        </figure>
      ) : null}

      <Card className="p-5 sm:p-6">
        <h2 className="font-display text-2xl text-forest">Rationale</h2>
        <p className="mt-3 whitespace-pre-line text-[16px] leading-[1.7] text-ink">{pick.rationale}</p>
      </Card>

      <section aria-labelledby="updates-heading" className="space-y-3">
        <h2 id="updates-heading" className="font-display text-2xl text-forest">
          Updates
        </h2>
        {updates && updates.length > 0 ? (
          <ol className="relative space-y-3 border-l border-gold/50 pl-5">
            {updates.map((u) => (
              <li key={u.id} className="relative">
                <span aria-hidden className="absolute -left-[25px] top-2 size-2.5 rounded-full border-2 border-ivory bg-gold" />
                <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-gold-deep">
                  {UPDATE_LABEL[u.kind] ?? u.kind} · {shortDateTime(u.published_at)}
                </p>
                <p className="mt-1 whitespace-pre-line text-[15px] leading-relaxed text-ink">{u.body}</p>
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-sm text-muted">No updates yet. Tito posts here when the pick moves.</p>
        )}
      </section>

      <PickFooter holds={pick.author_holds} />
    </article>
  );
}
