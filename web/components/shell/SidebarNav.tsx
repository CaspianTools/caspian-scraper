"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export interface SidebarNavItem {
  href: string;
  label: string;
  /** Active only on an exact path match (for a section's index page). */
  exact?: boolean;
}

/** Vertical section nav for a SidebarLayout sidebar (Overview / Sources / …). */
export function SidebarNav({ items, label }: { items: SidebarNavItem[]; label?: string }) {
  const pathname = usePathname() ?? "";
  return (
    <nav aria-label={label} className="flex flex-col gap-0.5">
      {items.map((t) => {
        const active = t.exact ? pathname === t.href : pathname === t.href || pathname.startsWith(t.href + "/");
        return (
          <Link
            key={t.href}
            href={t.href}
            aria-current={active ? "page" : undefined}
            className={
              "text-sm px-3 py-2 rounded-lg transition-colors " +
              (active
                ? "bg-zinc-100 text-zinc-900 font-medium dark:bg-zinc-800 dark:text-zinc-100"
                : "text-zinc-600 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-900")
            }
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
