import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { Card, EmptyState, PageTitle } from "@/components/ui";
import { longDate } from "@/lib/format";

export const metadata: Metadata = { title: "Notices" };

export default async function AnnouncementsPage() {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("announcements")
    .select("id, title, body, pinned, published_at")
    .is("deleted_at", null)
    .order("pinned", { ascending: false })
    .order("published_at", { ascending: false })
    .limit(50);
  if (error) throw new Error(`Could not load notices: ${error.message}`);

  return (
    <>
      <PageTitle eyebrow="From Tito" title="Notices">
        News, sessions and housekeeping for the Circle.
      </PageTitle>
      {data && data.length > 0 ? (
        <div className="space-y-4">
          {data.map((a, i) => (
            <Card key={a.id} className="rise p-5 sm:p-6">
              <div style={{ ["--i" as string]: Math.min(i, 7) }}>
                <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-muted">
                  {a.pinned ? <span className="text-gold-deep">Pinned · </span> : null}
                  {longDate(a.published_at)}
                </p>
                <h2 className="mt-1 font-display text-[1.7rem] leading-tight text-ink">{a.title}</h2>
                <p className="mt-2 whitespace-pre-line text-[15px] leading-relaxed text-ink/85">{a.body}</p>
              </div>
            </Card>
          ))}
        </div>
      ) : (
        <EmptyState title="Nothing new">Notices from Tito will appear here.</EmptyState>
      )}
    </>
  );
}
