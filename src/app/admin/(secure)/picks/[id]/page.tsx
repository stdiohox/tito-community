import type { Metadata } from "next";
import { requireStaffAal2 } from "@/lib/auth";
import Link from "next/link";
import { notFound } from "next/navigation";
import { UpdateForm } from "../../forms";
import { deletePick } from "../../../actions";
import { createClient } from "@/lib/supabase/server";
import { ActionBadge, PriceLadder, type Pick } from "@/components/pick-card";
import { SubmitButton } from "@/components/submit-button";
import { Card, Notice } from "@/components/ui";
import { shortDateTime } from "@/lib/format";

export const metadata: Metadata = { title: "Pick · Admin" };

export default async function AdminPick({ params, searchParams }: PageProps<"/admin/picks/[id]">) {
  // Layouts and pages render in parallel, so each page guards itself too.
  await requireStaffAal2();
  const { id } = await params;
  const { published } = await searchParams;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();

  const supabase = await createClient();
  const { data: pick, error: pickError } = await supabase
    .from("picks")
    .select("id, ticker, market, action, entry_price, target_price, stop_price, rationale, author_holds, chart_path, published_at, deleted_at, notified_at")
    .eq("id", id)
    .maybeSingle<Pick & { deleted_at: string | null; notified_at: string | null }>();
  if (pickError) throw new Error(`Could not load pick: ${pickError.message}`);
  if (!pick) notFound();

  const { data: updates } = await supabase
    .from("pick_updates")
    .select("id, kind, body, published_at")
    .eq("pick_id", id)
    .order("published_at", { ascending: true });

  return (
    <div className="space-y-6">
      <Link href="/admin/picks" className="text-sm text-muted hover:text-ink">
        ← All picks
      </Link>
      {published ? <Notice tone="success">Published. Members with access are being notified now.</Notice> : null}
      {pick.deleted_at ? <Notice tone="warning">Removed from the member feed on {shortDateTime(pick.deleted_at)}.</Notice> : null}

      <div className="flex flex-wrap items-center gap-3">
        <h1 className="font-display text-5xl text-ink">{pick.ticker}</h1>
        <ActionBadge action={pick.action} />
        <span className="font-mono text-xs text-muted">
          {pick.market} · {shortDateTime(pick.published_at)}
          {pick.notified_at ? ` · notified ${shortDateTime(pick.notified_at)}` : ""}
        </span>
      </div>
      <PriceLadder pick={pick} />
      <p className="whitespace-pre-line text-[15px] leading-relaxed">{pick.rationale}</p>
      {pick.author_holds ? <p className="text-sm font-medium">Holding disclosed to members.</p> : null}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="p-5">
          <h2 className="mb-4 font-display text-2xl text-forest">Post an update</h2>
          {pick.deleted_at ? <p className="text-sm text-muted">This pick is removed.</p> : <UpdateForm pickId={pick.id} />}
        </Card>
        <section>
          <h2 className="mb-3 font-display text-2xl text-forest">Updates</h2>
          <ol className="space-y-3">
            {(updates ?? []).map((u) => (
              <li key={u.id} className="rounded-xl border border-line bg-paper p-4 text-sm">
                <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-gold-deep">
                  {u.kind.replace("_", " ")} · {shortDateTime(u.published_at)}
                </p>
                <p className="mt-1 whitespace-pre-line">{u.body}</p>
              </li>
            ))}
            {(updates ?? []).length === 0 ? <li className="text-sm text-muted">None yet.</li> : null}
          </ol>
        </section>
      </div>

      {!pick.deleted_at ? (
        <form action={deletePick} className="border-t border-line pt-6">
          <input type="hidden" name="id" value={pick.id} />
          <p className="mb-3 text-sm text-muted">
            Removing hides the pick from members. It stays in the audit log and cannot be restored or edited.
          </p>
          <SubmitButton variant="danger" pending="Removing…">
            Remove from feed
          </SubmitButton>
        </form>
      ) : null}
    </div>
  );
}
