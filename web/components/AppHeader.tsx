import Link from "next/link";
import { UserMenu } from "./UserMenu";
import { QuickAddHeaderButton } from "./quick-add/QuickAddHeaderButton";
import type { UserSession } from "@/lib/auth/session";

interface Props {
  session: UserSession;
}

/**
 * Shared top bar shown on every authenticated page. Server component:
 * data flows in via the session prop from the route-group layout.
 */
export function AppHeader({ session }: Props) {
  return (
    <header className="border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 sticky top-0 z-30">
      <div className="max-w-6xl mx-auto px-6 h-14 flex items-center justify-between">
        <div className="flex items-center gap-6 min-w-0">
          <Link
            href="/"
            className="flex items-center gap-2 text-base font-semibold tracking-tight shrink-0"
          >
            <span aria-hidden className="text-lg">
              🛡
            </span>
            <span>Caspian Scraper</span>
          </Link>
          <nav className="hidden sm:flex items-center gap-1">
            <Link
              href="/"
              className="text-sm px-3 py-1.5 rounded-lg text-zinc-600 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-900 transition-colors"
            >
              Projects
            </Link>
            <Link
              href="/comparison"
              className="text-sm px-3 py-1.5 rounded-lg text-zinc-600 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-900 transition-colors"
            >
              Comparison
            </Link>
          </nav>
        </div>

        <div className="flex items-center gap-3">
          <QuickAddHeaderButton />
          <UserMenu
            session={{
              email: session.email,
              name: session.name,
              picture: session.picture,
            }}
          />
        </div>
      </div>
    </header>
  );
}
