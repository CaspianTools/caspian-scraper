import { redirect } from "next/navigation";
import { getSessionFromCookie } from "@/lib/auth/session";
import { ComparisonNav } from "@/components/ComparisonNav";

export const dynamic = "force-dynamic";

/**
 * Top-level Comparison layout. Sits inside the authed (app)/layout.tsx, so
 * the global AppHeader is already rendered above. Adds:
 *
 *   1. A breadcrumb sub-bar with the section title.
 *   2. The Comparison tab nav (Findings / Compare / Sources / Runs).
 *
 * Plan v2 §1 — top-level surface, per-user, not nested under any project.
 */
export default async function ComparisonLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSessionFromCookie();
  if (!session) redirect("/signin");

  return (
    <>
      <div className="border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950">
        <div className="max-w-6xl mx-auto px-6 h-12 flex items-center gap-3 min-w-0">
          <h1 className="text-sm font-semibold tracking-tight truncate">
            Comparison
          </h1>
          <span className="text-xs text-zinc-500 truncate">
            Cross-retailer product prices
          </span>
        </div>
      </div>

      <div className="max-w-6xl mx-auto px-6 py-6 space-y-6">
        <ComparisonNav />
        {children}
      </div>
    </>
  );
}
