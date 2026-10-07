import type { Metadata } from "next";
import { requireStaffAal2 } from "@/lib/auth";
import { AnnouncementForm } from "../forms";
import { deleteAnnouncement, setAnnouncementPinned } from "../../actions";
import { createClient } from "@/lib/supabase/server";
import { SubmitButton } from "@/components/submit-button";
import { Card, PageTitle } from "@/components/ui";
import { shortDateTime } from "@/lib/format";

export const metadata: Metadata = { title: "Notices · Admin" };

export default async function AdminAnnouncements() {
  // Layouts and pages render in parallel, so each page guards itself too.
  await requireStaffAal2();
  const supabase = await createClient();
  const { data } = await supabase
    .from("announcements")
    .select("id, title, body, pinned, published_at")
    .is("deleted_at", null)
    .order("pinned", { ascending: false })
    .order("published_at", { ascending: false });

  return (
    <div className="grid gap-10 lg:grid-cols-[1fr_1fr]">
      <section>
        <PageTitle eyebrow="New" title="Post a notice" />
        <Card className="p-5 sm:p-6">
          <AnnouncementForm />
        </Card>
      </section>
      <section aria-labelledby="live-notices">
        <h2 id="live-notices" className="mb-3 font-display text-2xl text-forest">
          Live notices
        </h2>
        <ul className="space-y-3">
          {(data ?? []).map((a) => (
            <li key={a.id} className="rounded-2xl border border-line bg-paper p-4">
              <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted">
                {a.pinned ? <span className="text-gold-deep">Pinned · </span> : null}
                {shortDateTime(a.published_at)}
              </p>
              <p className="mt-1 font-display text-xl">{a.title}</p>
              <p className="mt-1 line-clamp-3 text-sm text-muted">{a.body}</p>
              <div className="mt-3 flex gap-2">
                <form action={setAnnouncementPinned}>
                  <input type="hidden" name="id" value={a.id} />
                  <input type="hidden" name="pinned" value={a.pinned ? "false" : "true"} />
                  <SubmitButton variant="ghost">{a.pinned ? "Unpin" : "Pin"}</SubmitButton>
                </form>
                <form action={deleteAnnouncement}>
                  <input type="hidden" name="id" value={a.id} />
                  <SubmitButton variant="danger">Remove</SubmitButton>
                </form>
              </div>
            </li>
          ))}
          {(data ?? []).length === 0 ? <li className="text-sm text-muted">No notices yet.</li> : null}
        </ul>
      </section>
    </div>
  );
}
