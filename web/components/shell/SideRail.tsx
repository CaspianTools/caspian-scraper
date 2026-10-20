"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useQuickAdd } from "@/components/quick-add/QuickAddProvider";

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
    label: "AI Setup",
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
 * The app's primary navigation: a narrow icon rail pinned to the left edge.
 * Section pages put their own controls in a <SidebarLayout> sidebar next to it.
 */
export function SideRail() {
  const pathname = usePathname() ?? "/";
  const { open } = useQuickAdd();

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
        <button
          type="button"
          onClick={() => open({})}
          title="Add a job or source"
          className="w-10 h-10 rounded-xl bg-white text-black flex items-center justify-center text-xl leading-none hover:bg-zinc-200"
        >
          +<span className="sr-only">New</span>
        </button>
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
