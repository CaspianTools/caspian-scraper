import Link from "next/link";

/**
 * Full-width page body: a sidebar (page controls — section nav, filters,
 * search form) next to the app's SideRail, and the main content area. The
 * sidebar sticks below the AppHeader (h-14). Plain
 * component (no hooks), so server and client pages can both use it. On narrow
 * screens the sidebar stacks above the content.
 */
export function SidebarLayout({
  sidebar,
  children,
}: {
  sidebar: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col md:flex-row min-h-[calc(100vh-3.5rem)]">
      <aside className="md:w-72 xl:w-80 md:shrink-0 border-b md:border-b-0 md:border-r border-zinc-200/80 dark:border-zinc-800 bg-white dark:bg-zinc-950 md:sticky md:top-14 md:h-[calc(100vh-3.5rem)] md:overflow-y-auto">
        <div className="p-5 space-y-6">{sidebar}</div>
      </aside>
      <main className="flex-1 min-w-0 px-6 lg:px-10 py-8 space-y-6">{children}</main>
    </div>
  );
}

/** Page body without a sidebar — the same full-width main area. */
export function FullWidth({ children }: { children: React.ReactNode }) {
  return <main className="min-w-0 px-6 lg:px-10 py-8 space-y-6">{children}</main>;
}

/** Sidebar heading: optional back link, title, subtitle and a trailing badge. */
export function SidebarHeader({
  title,
  subtitle,
  back,
  badge,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  back?: { href: string; label: string };
  badge?: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      {back && (
        <Link
          href={back.href}
          className="inline-flex items-center gap-1 text-xs font-medium text-zinc-500 hover:text-brand-600 dark:hover:text-brand-400 transition-colors"
        >
          <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M15 18l-6-6 6-6" />
          </svg>
          {back.label}
        </Link>
      )}
      <div className="flex items-center gap-2 min-w-0">
        <h1 className="text-xl font-semibold tracking-tight text-zinc-900 dark:text-white truncate">{title}</h1>
        {badge}
      </div>
      {subtitle && <p className="text-sm text-zinc-500">{subtitle}</p>}
    </div>
  );
}
