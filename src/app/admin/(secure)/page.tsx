import type { Metadata } from "next";
import { requireStaffAal2 } from "@/lib/auth";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { daysUntil, shortDateTime } from "@/lib/format";
import { buttonClass, Card, PageTitle } from "@/components/ui";

export const metadata: Metadata = { title: "Admin" };

const ACTION_LABEL: Record<string, string> = {
  insert: "created",
  update: "changed",
  payment_recorded: "payment recorded",
  access_extended: "access extended",
  access_revoked: "access revoked",
  access_active: "access restored",
  member_invited: "member invited",
};

export default async function AdminHome() {
  // Layouts and pages render in parallel, so each page guards itself too.
  await requireStaffAal2();
  const supabase = await createClient();
  const [{ data: ents }, { data: settings }, { count: pickCount }, { data: audit }] = await Promise.all([
    supabase.from("entitlements").select("access_ends_at, status"),
    supabase.from("settings").select("grace_days").single(),
    supabase.from("picks").select("id", { count: "exact", head: true }).is("deleted_at", null),
    supabase.from("audit_log").select("id, action, target_type, created_at, detail").order("created_at", { ascending: false }).limit(12),
  ]);

  const grace = settings?.grace_days ?? 3;
  let active = 0;
  let expiring = 0;
  let lapsed = 0;
  for (const e of ents ?? []) {
    if (e.status !== "active" || !e.access_ends_at) continue;
    const d = daysUntil(e.access_ends_at);
    if (d + grace > 0) active++;
    else lapsed++;
    if (d > 0 && d <= 7) expiring++;
  }

  const stats = [
    { label: "Members with access", value: active },
    { label: "Ending within 7 days", value: expiring },
    { label: "Lapsed", value: lapsed },
    { label: "Live picks", value: pickCount ?? 0 },
  ];

  return (
    <>
      <PageTitle eyebrow="Overview" title="Good to see you." />
      <div className="mb-8 flex flex-wrap gap-3">
        <Link href="/admin/picks" className={buttonClass.gold}>
          Post a pick
        </Link>
        <Link href="/admin/members" className={buttonClass.ghost}>
          Invite a member
        </Link>
      </div>
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {stats.map((s) => (
          <Card key={s.label} className="p-4">
            <dt className="text-xs text-muted">{s.label}</dt>
            <dd className="tabular mt-1 font-display text-4xl text-forest">{s.value}</dd>
          </Card>
        ))}
      </dl>
      <section className="mt-10" aria-labelledby="audit-heading">
        <h2 id="audit-heading" className="mb-3 font-display text-2xl text-forest">
          Recent activity
        </h2>
        <ul className="divide-y divide-line rounded-2xl border border-line bg-paper">
          {(audit ?? []).map((a) => (
            <li key={a.id} className="flex items-center justify-between gap-4 px-4 py-3 text-sm">
              <span className="min-w-0 truncate">
                <span className="font-medium capitalize">{a.target_type.replace(/_/g, " ")}</span>{" "}
                <span className="text-muted">{ACTION_LABEL[a.action] ?? a.action.replace(/_/g, " ")}</span>
              </span>
              <span className="tabular shrink-0 text-xs text-muted">{shortDateTime(a.created_at)}</span>
            </li>
          ))}
          {(audit ?? []).length === 0 ? <li className="px-4 py-6 text-center text-sm text-muted">Nothing yet.</li> : null}
        </ul>
      </section>
    </>
  );
}
