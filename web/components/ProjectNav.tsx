"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

interface Tab {
  href: string;
  label: string;
}

export function ProjectNav({ projectId }: { projectId: string }) {
  const pathname = usePathname() ?? "";
  const base = `/projects/${projectId}`;

  const tabs: Tab[] = [
    { href: base, label: "Overview" },
    { href: `${base}/sources`, label: "Sources" },
    { href: `${base}/destinations`, label: "Destinations" },
    { href: `${base}/secrets`, label: "Secrets" },
    { href: `${base}/runs`, label: "Runs" },
    { href: `${base}/findings`, label: "Findings" },
    { href: `${base}/lessons`, label: "Lessons" },
    { href: `${base}/settings`, label: "Settings" },
  ];

  return (
    <nav className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 p-2 flex flex-wrap gap-1">
      {tabs.map((t) => {
        const active =
          t.href === base ? pathname === base : pathname.startsWith(t.href);
        return (
          <Link
            key={t.href}
            href={t.href}
            className={
              "text-sm px-3 py-1.5 rounded-lg transition-colors " +
              (active
                ? "bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100"
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
