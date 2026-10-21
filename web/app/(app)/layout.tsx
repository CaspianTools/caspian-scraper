import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getSessionFromCookie } from "@/lib/auth/session";
import { SideRail } from "@/components/shell/SideRail";
import { RAIL_COOKIE } from "@/components/shell/rail";
import { AppHeader } from "@/components/shell/AppHeader";
import { QuickAddProvider } from "@/components/quick-add/QuickAddProvider";

export const dynamic = "force-dynamic";

/**
 * App route-group layout. Every page under app/(app)/ inherits this: the
 * session (always the local one — see lib/auth/session.ts), the
 * full-height SideRail on the left (collapsed if the `rail` cookie says so)
 * and the AppHeader (h-14, with Quick add)
 * across the top. Pages fill the rest, usually via <SidebarLayout> (page
 * sidebar + main area) or <FullWidth>.
 *
 * The parentheses in "(app)" make this a Next.js route group — the
 * folder doesn't appear in URLs.
 */
export default async function AuthedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSessionFromCookie();
  if (!session) redirect("/signin");
  const railCollapsed = (await cookies()).get(RAIL_COOKIE)?.value === "collapsed";

  return (
    <QuickAddProvider>
      <div className="min-h-screen flex bg-zinc-50/70 dark:bg-black">
        <SideRail defaultCollapsed={railCollapsed} />
        <div className="flex-1 min-w-0">
          <AppHeader />
          {children}
        </div>
      </div>
    </QuickAddProvider>
  );
}
