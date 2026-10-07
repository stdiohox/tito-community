import Link from "next/link";
import type { ReactNode } from "react";
import { signOut } from "@/app/sign-in/actions";
import { MemberNav } from "@/components/nav";
import { SwRegister } from "@/components/sw-register";
import { SkipLink, Wordmark } from "@/components/ui";

/** Forest header, ivory page, bottom tabs on phones. */
export function AppShell({
  children,
  isStaff,
  banner,
}: {
  children: ReactNode;
  isStaff: boolean;
  banner?: ReactNode;
}) {
  return (
    <div className="min-h-dvh pb-[calc(4rem+env(safe-area-inset-bottom))] md:pb-0">
      <SkipLink />
      <SwRegister />
      <header className="on-dark sticky top-0 z-30 bg-forest pt-[env(safe-area-inset-top)] text-ivory">
        <div className="mx-auto flex h-16 max-w-3xl items-center justify-between gap-4 px-4 sm:px-6">
          <Link href="/picks" aria-label="Tito Circle home">
            <Wordmark />
          </Link>
          <div className="hidden md:block">
            <MemberNav />
          </div>
          <div className="flex items-center gap-1">
            {isStaff ? (
              <Link
                href="/admin"
                className="rounded-full border border-gold/50 px-3 py-1.5 text-xs font-medium text-gold transition-colors hover:bg-gold/10"
              >
                Admin
              </Link>
            ) : null}
            <form action={signOut}>
              <button type="submit" className="rounded-full px-3 py-1.5 text-xs text-ivory/75 transition-colors hover:text-ivory">
                Sign out
              </button>
            </form>
          </div>
        </div>
        <div className="h-px bg-gradient-to-r from-transparent via-gold/60 to-transparent" />
      </header>
      {banner}
      <main id="content" tabIndex={-1} className="mx-auto max-w-3xl px-4 py-8 outline-none sm:px-6">{children}</main>
      <div className="md:hidden">
        <MemberNav />
      </div>
    </div>
  );
}
