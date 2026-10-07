import { requireMember } from "@/lib/auth";
import { daysUntil, longDate } from "@/lib/format";
import { AppShell } from "@/components/app-shell";
import Link from "next/link";

/**
 * Members with live access (or staff). Expired members are sent to /renew.
 * RLS enforces the same rule on every query underneath, so even if this
 * guard were bypassed the pages would render empty.
 */
export default async function MemberLayout({ children }: LayoutProps<"/">) {
  const state = await requireMember();

  let banner = null;
  if (state.accessEndsAt && !state.isStaff) {
    const days = daysUntil(state.accessEndsAt);
    if (days <= 7) {
      banner = (
        <div className="border-b border-gold/40 bg-gold-soft/60">
          <p className="mx-auto max-w-3xl px-4 py-2.5 text-sm text-ink sm:px-6">
            {days > 0
              ? `Your access ends in ${days} day${days === 1 ? "" : "s"}, on ${longDate(state.accessEndsAt)}. `
              : `Your membership ended on ${longDate(state.accessEndsAt)}. You are in your grace period. `}
            <Link href="/membership" className="font-medium text-forest underline underline-offset-4">
              Renew now
            </Link>
          </p>
        </div>
      );
    }
  }

  return (
    <AppShell isStaff={state.isStaff} banner={banner}>
      {children}
    </AppShell>
  );
}
