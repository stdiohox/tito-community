"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const ITEMS = [
  { href: "/picks", label: "Picks", icon: PicksIcon },
  { href: "/announcements", label: "Notices", icon: NoticeIcon },
  { href: "/membership", label: "Membership", icon: MemberIcon },
];

/** Bottom tab bar on phones; a quiet inline row from md up. */
export function MemberNav() {
  const path = usePathname();
  return (
    <nav
      aria-label="Main"
      className="on-dark fixed inset-x-0 bottom-0 z-40 border-t border-gold/20 bg-forest-900/95 pb-[env(safe-area-inset-bottom)] backdrop-blur-md md:static md:border-0 md:bg-transparent md:pb-0 md:backdrop-blur-none"
    >
      <ul className="mx-auto grid max-w-md grid-cols-3 md:flex md:max-w-none md:gap-1">
        {ITEMS.map(({ href, label, icon: Icon }) => {
          const active = path === href || path.startsWith(`${href}/`);
          return (
            <li key={href}>
              <Link
                href={href}
                aria-current={active ? "page" : undefined}
                className={`flex h-16 flex-col items-center justify-center gap-1 text-[11px] font-medium tracking-wide transition-colors md:h-10 md:flex-row md:gap-2 md:rounded-full md:px-4 md:text-sm ${
                  active ? "text-gold md:bg-forest-700" : "text-ivory/70 hover:text-ivory"
                }`}
              >
                <Icon />
                {label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

function PicksIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden className="md:hidden">
      <path d="M4 17l5-5 4 4 7-8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M15 8h5v5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function NoticeIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden className="md:hidden">
      <path d="M5 5h14v10H9l-4 4V5z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  );
}

function MemberIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden className="md:hidden">
      <circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="12" cy="10" r="2.6" stroke="currentColor" strokeWidth="1.6" />
      <path d="M7.5 17c1.2-1.8 2.7-2.6 4.5-2.6s3.3.8 4.5 2.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
