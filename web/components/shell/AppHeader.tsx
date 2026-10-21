"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { useQuickAdd } from "@/components/quick-add/QuickAddProvider";

/** Section names by path prefix, most specific first. */
const SECTIONS: [string, string][] = [
  ["/projects", "Jobs"],
  ["/resources", "Resources"],
  ["/db", "Findings database"],
  ["/comparison", "Compare"],
  ["/cars", "Cars"],
  ["/aiconfig", "Scrape any website"],
  ["/settings", "Settings"],
];

function sectionOf(pathname: string): string {
  if (pathname === "/") return "Jobs";
  return SECTIONS.find(([p]) => pathname === p || pathname.startsWith(p + "/"))?.[1] ?? "";
}

/** True when a key press belongs to a text field, not a shortcut. */
function isTyping(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el) return false;
  return el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName);
}

/**
 * The bar across the top of every page (right of the SideRail): the current
 * section and the Quick add button, which opens the Quick add popup. Press N
 * anywhere outside a text field to open it too.
 */
export function AppHeader() {
  const pathname = usePathname() ?? "/";
  const { open, isOpen } = useQuickAdd();

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (isOpen || e.repeat || e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;
      if (e.key === "n" || e.key === "N") {
        e.preventDefault();
        open({});
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, isOpen]);

  return (
    <header className="sticky top-0 z-30 h-14 flex items-center gap-3 px-6 lg:px-8 border-b border-zinc-200 dark:border-zinc-800 bg-white/85 dark:bg-zinc-950/85 backdrop-blur">
      <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300 truncate">{sectionOf(pathname)}</p>
      <button
        type="button"
        onClick={() => open({})}
        title="Quick add (N)"
        className="ml-auto inline-flex items-center gap-2 h-9 pl-3 pr-2 rounded-lg bg-black text-white text-sm font-medium hover:bg-zinc-800 dark:bg-white dark:text-black dark:hover:bg-zinc-200"
      >
        <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden>
          <path d="M12 5v14M5 12h14" />
        </svg>
        Quick add
        <kbd className="ml-1 hidden sm:inline-flex items-center justify-center h-5 min-w-5 px-1 rounded border border-white/30 dark:border-black/20 text-[10px] font-mono">
          N
        </kbd>
      </button>
    </header>
  );
}
