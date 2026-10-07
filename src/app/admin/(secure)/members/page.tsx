import type { Metadata } from "next";
import { requireStaffAal2 } from "@/lib/auth";
import { InviteForm } from "../forms";
import { extendAccess, setAccessStatus } from "../../actions";
import { createClient } from "@/lib/supabase/server";
import { SubmitButton } from "@/components/submit-button";
import { Card, PageTitle } from "@/components/ui";
import { daysUntil, longDate } from "@/lib/format";

export const metadata: Metadata = { title: "Members · Admin" };

type Row = {
  user_id: string;
  email: string;
  full_name: string | null;
  access_ends_at: string | null;
  status: "active" | "revoked" | null;
  isStaff: boolean;
};

function standing(r: Row, grace: number): { label: string; tone: string } {
  if (r.isStaff) return { label: "Staff", tone: "bg-ink text-ivory" };
  if (r.status === "revoked") return { label: "Revoked", tone: "bg-danger/10 text-danger" };
  if (!r.access_ends_at) return { label: "No access", tone: "bg-ink/10 text-muted" };
  const d = daysUntil(r.access_ends_at);
  if (d > 7) return { label: `${d} days left`, tone: "bg-forest/10 text-forest" };
  if (d > 0) return { label: `${d} day${d === 1 ? "" : "s"} left`, tone: "bg-gold-soft text-ink" };
  if (d + grace > 0) return { label: "In grace", tone: "bg-gold-soft text-ink" };
  return { label: "Expired", tone: "bg-ink/10 text-muted" };
}

export default async function AdminMembers() {
  // Layouts and pages render in parallel, so each page guards itself too.
  await requireStaffAal2();
  const supabase = await createClient();
  const [{ data: profiles }, { data: ents }, { data: settings }, { data: staffRows }] = await Promise.all([
    supabase.from("profiles").select("user_id, email, full_name").order("created_at", { ascending: false }),
    supabase.from("entitlements").select("user_id, access_ends_at, status"),
    supabase.from("settings").select("grace_days").single(),
    supabase.from("staff").select("user_id"),
  ]);
  const grace = settings?.grace_days ?? 3;
  const entBy = new Map((ents ?? []).map((e) => [e.user_id, e]));
  const staff = new Set((staffRows ?? []).map((s) => s.user_id));

  const rows: Row[] = (profiles ?? []).map((p) => ({
    ...p,
    access_ends_at: entBy.get(p.user_id)?.access_ends_at ?? null,
    status: entBy.get(p.user_id)?.status ?? null,
    isStaff: staff.has(p.user_id),
  }));

  return (
    <>
      <PageTitle eyebrow="Members" title="Manage members">
        Invite by email. Extending adds days on top of what a member already holds. Revoking ends access immediately, whatever they
        have paid; restore it at any time.
      </PageTitle>
      <Card className="mb-8 p-5 sm:p-6">
        <h2 className="mb-4 font-display text-2xl text-forest">Invite a member</h2>
        <InviteForm />
      </Card>

      <ul className="space-y-3">
        {rows.map((r) => {
          const s = standing(r, grace);
          return (
            <li key={r.user_id} className="rounded-2xl border border-line bg-paper p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate font-medium">{r.full_name || r.email}</p>
                  {r.full_name ? <p className="truncate text-sm text-muted">{r.email}</p> : null}
                  <p className="mt-1 text-xs text-muted">{r.access_ends_at ? `Access to ${longDate(r.access_ends_at)}` : "No access granted"}</p>
                </div>
                <span className={`rounded-full px-3 py-1 text-xs font-medium ${s.tone}`}>{s.label}</span>
              </div>
              {!r.isStaff ? (
                <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3">
                  <form action={extendAccess} className="flex items-center gap-2">
                    <input type="hidden" name="user_id" value={r.user_id} />
                    <label className="sr-only" htmlFor={`days-${r.user_id}`}>
                      Days to add
                    </label>
                    <select id={`days-${r.user_id}`} name="days" defaultValue="30" className="h-11 rounded-full border border-line bg-paper px-3 text-sm">
                      <option value="7">+7 days</option>
                      <option value="30">+30 days</option>
                      <option value="90">+90 days</option>
                      <option value="182">+6 months</option>
                      <option value="365">+1 year</option>
                    </select>
                    <SubmitButton variant="ghost" pending="Extending…">
                      Extend
                    </SubmitButton>
                  </form>
                  <form action={setAccessStatus} className="ml-auto">
                    <input type="hidden" name="user_id" value={r.user_id} />
                    <input type="hidden" name="status" value={r.status === "revoked" ? "active" : "revoked"} />
                    {r.status === "revoked" ? (
                      <SubmitButton variant="ghost">Restore</SubmitButton>
                    ) : r.status ? (
                      <SubmitButton variant="danger">Revoke</SubmitButton>
                    ) : null}
                  </form>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </>
  );
}
