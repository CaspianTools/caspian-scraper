"use client";

import Link from "next/link";
import { useState } from "react";
import { usePathname } from "next/navigation";
import { RAIL_COOKIE } from "./rail";

interface Item {
  href: string;
  label: string;
  /** Path prefixes that count as this section. */
  match: string[];
  icon: React.ReactNode;
}

const stroke = { fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round", strokeLinejoin: "round" } as const;

const icon = (d: React.ReactNode) => (
  <svg viewBox="0 0 24 24" className="w-[18px] h-[18px] shrink-0" {...stroke} aria-hidden>
    {d}
  </svg>
);

const GROUPS: { label: string; items: Item[] }[] = [
  {
    label: "Workspace",
    items: [
      {
        href: "/",
        label: "Jobs",
        match: ["/projects"],
        icon: icon(
          <>
            <rect x="3" y="7" width="18" height="13" rx="2" />
            <path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 13h18" />
          </>,
        ),
      },
      {
        href: "/resources",
        label: "Resources",
        match: ["/resources"],
        icon: icon(
          <>
            <circle cx="12" cy="12" r="9" />
            <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
          </>,
        ),
      },
      {
        href: "/db",
        label: "Findings DB",
        match: ["/db"],
        icon: icon(
          <>
            <ellipse cx="12" cy="5.5" rx="8" ry="2.5" />
            <path d="M4 5.5v13c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5v-13M4 12c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5" />
          </>,
        ),
      },
    ],
  },
];

const SETTINGS: Item = {
  href: "/settings",
  label: "Settings",
  match: ["/settings"],
  icon: icon(
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </>,
  ),
};

function isActive(item: Item, pathname: string): boolean {
  if (item.href === "/" && pathname === "/") return true;
  return item.match.some((m) => pathname === m || pathname.startsWith(m + "/"));
}

function NavLink({ item, pathname, collapsed }: { item: Item; pathname: string; collapsed: boolean }) {
  const active = isActive(item, pathname);
  return (
    <Link
      href={item.href}
      title={collapsed ? item.label : undefined}
      aria-current={active ? "page" : undefined}
      className={
        "group relative flex items-center gap-3 h-9 rounded-lg text-sm transition-colors " +
        (collapsed ? "justify-center w-10 mx-auto" : "px-2.5") +
        " " +
        (active
          ? "bg-white text-zinc-900 font-medium shadow-card ring-1 ring-zinc-200 dark:bg-zinc-800/80 dark:text-white dark:ring-zinc-700/60"
          : "text-zinc-600 hover:bg-zinc-200/50 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800/50 dark:hover:text-zinc-100")
      }
    >
      <span className={active ? "text-brand-600 dark:text-brand-400" : "text-zinc-400 group-hover:text-zinc-600 dark:text-zinc-500 dark:group-hover:text-zinc-300"}>
        {item.icon}
      </span>
      {!collapsed && <span className="truncate">{item.label}</span>}
    </Link>
  );
}

/**
 * The app's primary navigation, pinned to the left edge: brand, grouped
 * section links and Settings, with a local-mode status card at the bottom
 * (Quick add is in the AppHeader). Collapses to an icon rail; the choice is
 * kept in the `rail` cookie so the server renders it the same way. Section
 * pages put their own controls in a <SidebarLayout> sidebar next to it.
 */
export function SideRail({ defaultCollapsed = false }: { defaultCollapsed?: boolean }) {
  const pathname = usePathname() ?? "/";
  const [collapsed, setCollapsed] = useState(defaultCollapsed);

  function toggle() {
    const next = !collapsed;
    setCollapsed(next);
    document.cookie = `${RAIL_COOKIE}=${next ? "collapsed" : "open"}; path=/; max-age=31536000; samesite=lax`;
  }

  return (
    <nav
      aria-label="Main"
      className={
        "shrink-0 sticky top-0 h-screen flex flex-col border-r border-zinc-200/80 dark:border-zinc-800 bg-zinc-50/80 dark:bg-zinc-950 transition-[width] duration-200 " +
        (collapsed ? "w-[64px]" : "w-[64px] lg:w-60")
      }
    >
      {/* Brand */}
      <div className={"h-14 flex items-center gap-2.5 shrink-0 " + (collapsed ? "justify-center" : "justify-center lg:justify-start lg:px-4")}>
        <Link
          href="/"
          title="Caspian Scraper"
          className="w-8 h-8 rounded-lg bg-gradient-to-br from-brand-500 to-brand-700 flex items-center justify-center text-white shadow-sm shadow-brand-600/30 ring-1 ring-inset ring-white/15 shrink-0"
        >
          <svg viewBox="0 0 24 24" className="w-[18px] h-[18px]" {...stroke} strokeWidth={2} aria-hidden>
            <path d="M12 3l8 3v6c0 4.5-3.4 8-8 9-4.6-1-8-4.5-8-9V6z" />
          </svg>
          <span className="sr-only">Caspian Scraper</span>
        </Link>
        {!collapsed && (
          <div className="hidden lg:block min-w-0 leading-tight">
            <p className="text-sm font-semibold tracking-tight text-zinc-900 dark:text-white truncate">Caspian</p>
            <p className="text-[11px] text-zinc-500 truncate">Scraper console</p>
          </div>
        )}
      </div>

      <div className={"flex-1 overflow-y-auto py-3 space-y-5 " + (collapsed ? "px-2" : "px-2 lg:px-3")}>
        {GROUPS.map((g) => (
          <div key={g.label} className="space-y-0.5">
            {!collapsed && (
              <p className="hidden lg:block px-2.5 pb-1.5 text-[11px] font-medium uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
                {g.label}
              </p>
            )}
            {g.items.map((item) => (
              <NavLink key={item.href} item={item} pathname={pathname} collapsed={collapsed} />
            ))}
          </div>
        ))}
      </div>

      <div className={"shrink-0 pb-3 pt-2 space-y-2 " + (collapsed ? "px-2" : "px-2 lg:px-3")}>
        <NavLink item={SETTINGS} pathname={pathname} collapsed={collapsed} />

        {/* Local-mode status */}
        <div
          title="Running on this computer — no sign-in. Data lives in data/ (committed) and local-data/ (this computer only)."
          className={
            "flex items-center gap-2.5 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 " +
            (collapsed ? "justify-center h-10 w-10 mx-auto" : "justify-center h-10 w-10 mx-auto lg:mx-0 lg:w-auto lg:h-auto lg:justify-start lg:p-2.5")
          }
        >
          <span className="relative flex h-2 w-2 shrink-0">
            <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-60 animate-ping" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
          </span>
          {!collapsed && (
            <div className="hidden lg:block min-w-0 leading-tight">
              <p className="text-xs font-medium text-zinc-800 dark:text-zinc-200">Running locally</p>
              <p className="text-[11px] text-zinc-500 truncate">data/ · local-data/</p>
            </div>
          )}
        </div>

        <button
          type="button"
          onClick={toggle}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          className={
            "hidden lg:flex items-center gap-3 h-8 rounded-lg text-xs text-zinc-500 hover:bg-zinc-200/50 hover:text-zinc-800 dark:hover:bg-zinc-800/50 dark:hover:text-zinc-200 transition-colors " +
            (collapsed ? "justify-center w-10 mx-auto" : "px-2.5 w-full")
          }
        >
          <svg viewBox="0 0 24 24" className="w-4 h-4 shrink-0" {...stroke} aria-hidden>
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <path d={collapsed ? "M9 4v16M13 10l2 2-2 2" : "M9 4v16M16 10l-2 2 2 2"} />
          </svg>
          {!collapsed && <span>Collapse</span>}
        </button>
      </div>
    </nav>
  );
}
