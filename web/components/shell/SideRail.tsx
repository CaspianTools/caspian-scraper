"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

interface Item {
  href: string;
  label: string;
  /** Path prefixes that count as this section. */
  match: string[];
  icon: React.ReactNode;
}

const stroke = { fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round", strokeLinejoin: "round" } as const;

const ITEMS: Item[] = [
  {
    href: "/",
    label: "Jobs",
    match: ["/projects"],
    icon: (
      <svg viewBox="0 0 24 24" className="w-5 h-5" {...stroke} aria-hidden>
        <rect x="3" y="7" width="18" height="13" rx="2" />
        <path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 13h18" />
      </svg>
    ),
  },
  {
    href: "/resources",
    label: "Resources",
    match: ["/resources"],
    icon: (
      <svg viewBox="0 0 24 24" className="w-5 h-5" {...stroke} aria-hidden>
        <circle cx="12" cy="12" r="9" />
        <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
      </svg>
    ),
  },
  {
    href: "/db",
    label: "DB",
    match: ["/db"],
    icon: (
      <svg viewBox="0 0 24 24" className="w-5 h-5" {...stroke} aria-hidden>
        <ellipse cx="12" cy="5.5" rx="8" ry="2.5" />
        <path d="M4 5.5v13c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5v-13M4 12c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5" />
      </svg>
    ),
  },
  {
    href: "/comparison",
    label: "Compare",
    match: ["/comparison"],
    icon: (
      <svg viewBox="0 0 24 24" className="w-5 h-5" {...stroke} aria-hidden>
        <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
      </svg>
    ),
  },
  {
    href: "/cars",
    label: "Cars",
    match: ["/cars"],
    icon: (
      <svg viewBox="0 0 24 24" className="w-5 h-5" {...stroke} aria-hidden>
        <path d="M5 16V11l2-5h10l2 5v5M5 16h14M5 16v2M19 16v2M3 11h18" />
        <circle cx="8" cy="13.5" r=".5" />
        <circle cx="16" cy="13.5" r=".5" />
      </svg>
    ),
  },
  {
    href: "/aiconfig",
    label: "Any site",
    match: ["/aiconfig"],
    icon: (
      <svg viewBox="0 0 24 24" className="w-5 h-5" {...stroke} aria-hidden>
        <path d="M12 3l1.8 4.6L18 9l-4.2 1.4L12 15l-1.8-4.6L6 9l4.2-1.4zM18 15l.9 2.1L21 18l-2.1.9L18 21l-.9-2.1L15 18l2.1-.9z" />
      </svg>
    ),
  },
];

function isActive(item: Item, pathname: string): boolean {
  if (item.href === "/" && pathname === "/") return true;
  return item.match.some((m) => pathname === m || pathname.startsWith(m + "/"));
}

/**
 * The app's primary navigation: a narrow icon rail pinned to the left edge,
 * with Settings at the bottom (Quick add is in the AppHeader). Section pages
 * put their own controls in a <SidebarLayout> sidebar next to it.
 */
export function SideRail() {
  const pathname = usePathname() ?? "/";

  return (
    <nav
      aria-label="Main"
      className="w-[68px] shrink-0 sticky top-0 h-screen flex flex-col items-center gap-1 py-3 bg-zinc-950 text-zinc-400 border-r border-zinc-900"
    >
      <Link href="/" title="Caspian Scraper" className="mb-3 w-10 h-10 rounded-xl bg-white/10 flex items-center justify-center text-white">
        <svg viewBox="0 0 24 24" className="w-5 h-5" {...stroke} aria-hidden>
          <path d="M12 3l8 3v6c0 4.5-3.4 8-8 9-4.6-1-8-4.5-8-9V6z" />
        </svg>
        <span className="sr-only">Caspian Scraper</span>
      </Link>

      {ITEMS.map((item) => {
        const active = isActive(item, pathname);
        return (
          <Link
            key={item.href}
            href={item.href}
            title={item.label}
            aria-current={active ? "page" : undefined}
            className={
              "w-14 py-2 rounded-xl flex flex-col items-center gap-1 text-[10px] leading-none transition-colors " +
              (active ? "bg-white/10 text-white" : "hover:bg-white/5 hover:text-zinc-200")
            }
          >
            {item.icon}
            <span>{item.label}</span>
          </Link>
        );
      })}

      <div className="mt-auto flex flex-col items-center gap-2">
        <Link
          href="/settings"
          title="Settings"
          aria-current={pathname.startsWith("/settings") ? "page" : undefined}
          className={
            "w-14 py-2 rounded-xl flex flex-col items-center gap-1 text-[10px] leading-none transition-colors " +
            (pathname.startsWith("/settings") ? "bg-white/10 text-white" : "hover:bg-white/5 hover:text-zinc-200")
          }
        >
          <svg viewBox="0 0 24 24" className="w-5 h-5" {...stroke} aria-hidden>
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
          </svg>
          <span>Settings</span>
        </Link>
        <span
          title="Running on this computer — no sign-in. Data lives in data/ (committed) and local-data/ (this computer only)."
          className="text-[10px] px-1.5 py-0.5 rounded bg-white/10 text-zinc-300"
        >
          Local
        </span>
      </div>
    </nav>
  );
}
