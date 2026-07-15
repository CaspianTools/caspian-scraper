import { redirect } from "next/navigation";
import { getSessionFromCookie } from "@/lib/auth/session";
import { CarsNav } from "@/components/CarsNav";

export const dynamic = "force-dynamic";

/**
 * Top-level Cars layout. Sits inside the authed (app)/layout.tsx, so the
 * global AppHeader is already rendered above. Adds a breadcrumb sub-bar
 * and the Cars tab nav (Listings / Sources / Runs).
 *
 * Car sources reuse the standalone `classifieds/` scraper as their engine
 * (scrape.py:run_car_source) — top-level, per-user, not nested under a project.
 */
export default async function CarsLayout({
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
            Cars
          </h1>
          <span className="text-xs text-zinc-500 truncate">
            Car classifieds (OpenSooq / Dubizzle / YallaMotor — Oman)
          </span>
        </div>
      </div>

      <div className="max-w-6xl mx-auto px-6 py-6 space-y-6">
        <CarsNav />
        {children}
      </div>
    </>
  );
}
