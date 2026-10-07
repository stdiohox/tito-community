import Link from "next/link";
import { requireStaffAal2 } from "@/lib/auth";
import { AdminNav } from "./admin-nav";
import { SkipLink, Wordmark } from "@/components/ui";

export default async function AdminLayout({ children }: LayoutProps<"/admin">) {
  const state = await requireStaffAal2();
  return (
    <div className="min-h-dvh bg-ivory">
      <SkipLink />
      <header className="on-dark sticky top-0 z-30 bg-ink pt-[env(safe-area-inset-top)] text-ivory">
        <div className="mx-auto flex h-14 max-w-5xl items-center justify-between gap-3 px-4 sm:px-6">
          <Link href="/admin" className="flex items-baseline gap-2">
            <Wordmark className="text-xl" />
            <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-gold">Admin</span>
          </Link>
          <div className="flex items-center gap-3 text-xs">
            <span className="hidden text-ivory/60 sm:inline">{state.viewer.email}</span>
            <Link href="/picks" className="rounded-full border border-ivory/25 px-3 py-1.5 text-ivory/85 hover:text-ivory">
              Member view
            </Link>
          </div>
        </div>
        <AdminNav />
      </header>
      <main id="content" tabIndex={-1} className="mx-auto max-w-5xl px-4 py-8 outline-none sm:px-6">{children}</main>
    </div>
  );
}
