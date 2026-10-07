"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const ITEMS = [
  { href: "/admin", label: "Overview" },
  { href: "/admin/picks", label: "Picks" },
  { href: "/admin/announcements", label: "Notices" },
  { href: "/admin/members", label: "Members" },
  { href: "/admin/products", label: "Products" },
];

export function AdminNav() {
  const path = usePathname();
  return (
    <nav aria-label="Admin" className="border-t border-ivory/10">
      <ul className="mx-auto flex max-w-5xl gap-1 overflow-x-auto px-3 sm:px-5">
        {ITEMS.map((item) => {
          const active = item.href === "/admin" ? path === "/admin" : path.startsWith(item.href);
          return (
            <li key={item.href} className="shrink-0">
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={`relative block px-3 py-3 text-sm transition-colors ${active ? "text-gold" : "text-ivory/70 hover:text-ivory"}`}
              >
                {item.label}
                {active ? <span aria-hidden className="absolute inset-x-3 bottom-0 h-0.5 rounded-full bg-gold" /> : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
