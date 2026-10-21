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
              "relative text-sm px-3 h-9 flex items-center rounded-lg transition-colors " +
              (active
                ? "bg-brand-50 text-brand-700 font-medium dark:bg-brand-500/10 dark:text-brand-300"
                : "text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-900 dark:hover:text-zinc-100")
            }
          >
            {active && <span aria-hidden className="absolute left-0 top-2 bottom-2 w-0.5 rounded-full bg-brand-600 dark:bg-brand-400" />}
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
