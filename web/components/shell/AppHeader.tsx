"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { useQuickAdd } from "@/components/quick-add/QuickAddProvider";

/** Section names by path prefix, most specific first. */
const SECTIONS: [string, string][] = [
  ["/projects", "Jobs"],
  ["/resources", "Resources"],
  ["/db", "Findings database"],
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
 * The bar across the top of every page (right of the SideRail): a
 * breadcrumb with the current section and the Quick add button, which opens
 * the Quick add popup. Press N anywhere outside a text field to open it too.
 */
export function AppHeader() {
  const pathname = usePathname() ?? "/";
  const { open, isOpen } = useQuickAdd();
  const section = sectionOf(pathname);

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
    <header className="sticky top-0 z-30 h-14 flex items-center gap-3 px-6 lg:px-8 border-b border-zinc-200/80 dark:border-zinc-800 bg-white/80 dark:bg-zinc-950/80 backdrop-blur-xl backdrop-saturate-150">
      <nav aria-label="Breadcrumb" className="flex items-center gap-2 min-w-0 text-sm">
        <span className="text-zinc-400 dark:text-zinc-500 hidden sm:inline">Caspian</span>
        <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 text-zinc-300 dark:text-zinc-600 hidden sm:block shrink-0" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden>
          <path d="M9 6l6 6-6 6" />
        </svg>
        <span className="font-medium text-zinc-900 dark:text-zinc-100 truncate">{section}</span>
      </nav>
      <button
        type="button"
        onClick={() => open({})}
        title="Quick add (N)"
        className="ml-auto inline-flex items-center gap-2 h-9 pl-3 pr-2 rounded-lg bg-brand-600 text-white text-sm font-medium shadow-sm shadow-brand-600/25 ring-1 ring-inset ring-white/10 hover:bg-brand-500 dark:bg-brand-500 dark:hover:bg-brand-400 transition-colors"
      >
        <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden>
          <path d="M12 5v14M5 12h14" />
        </svg>
        Quick add
        <kbd className="ml-1 hidden sm:inline-flex items-center justify-center h-5 min-w-5 px-1 rounded-md bg-white/15 text-[10px] font-mono font-medium">
          N
        </kbd>
      </button>
    </header>
  );
}
